use axum::{
    extract::State,
    http::{header::SET_COOKIE, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};

use crate::AppState;

#[derive(Clone, Debug, FromRow)]
pub(crate) struct AuthUser {
    pub id: String,
    pub username: String,
    pub account_type: String,
    pub status: String,
    pub timeout_until: Option<i64>,
}

pub(crate) async fn current_user(
    headers: &HeaderMap,
    pool: &PgPool,
) -> Result<Option<AuthUser>, sqlx::Error> {
    let token = headers
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                let cookie = cookie.trim();
                cookie.strip_prefix("mallowcord_device=")
            })
        });

    let Some(token) = token.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let now = chrono::Utc::now().timestamp();

    let user = sqlx::query_as::<_, AuthUser>(
        "SELECT u.id, u.username, u.account_type, u.status, u.timeout_until
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > $2
         LIMIT 1",
    )
    .bind(token_hash)
    .bind(now)
    .fetch_optional(pool)
    .await?;

    Ok(user.filter(|user| user.status != "banned" && user.status != "deleted"))
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(pool) = state.database.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "database_not_configured"})),
        )
            .into_response();
    };

    match current_user(&headers, pool).await {
        Ok(Some(user)) => Json(json!({
            "user": {
                "id": user.id,
                "username": user.username,
                "account_type": user.account_type
            }
        }))
        .into_response(),
        Ok(None) => (StatusCode::UNAUTHORIZED, Json(json!({"error": "Not signed in."})))
            .into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to resolve current MallowCord session");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            )
                .into_response()
        }
    }
}


const CLEAR_DEVICE_COOKIE: &str =
    "mallowcord_device=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0";

fn clear_device_cookie(mut response: Response) -> Response {
    response.headers_mut().insert(
        SET_COOKIE,
        HeaderValue::from_static(CLEAR_DEVICE_COOKIE),
    );
    response
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(pool) = state.database.as_ref() else {
        return clear_device_cookie(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "database_not_configured"})),
            )
                .into_response(),
        );
    };

    if let Some(token) = headers
        .get(axum::http::header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies.split(';').find_map(|cookie| {
                cookie.trim().strip_prefix("mallowcord_device=")
            })
        })
        .filter(|value| !value.is_empty())
    {
        let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
        match sqlx::query_scalar::<_, String>(
            "DELETE FROM sessions WHERE token_hash = $1 RETURNING user_id",
        )
        .bind(token_hash)
        .fetch_optional(pool)
        .await
        {
            Ok(Some(user_id)) => {
                if let Err(error) = sqlx::query("DELETE FROM user_presence WHERE user_id = $1")
                    .bind(user_id)
                    .execute(pool)
                    .await
                {
                    tracing::warn!(%error, "failed to clear presence during logout");
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::error!(%error, "session logout failed");
                return clear_device_cookie(
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(json!({"error": "logout_failed"})),
                    )
                        .into_response(),
                );
            }
        }
    }

    clear_device_cookie(Json(json!({"ok": true})).into_response())
}

#[derive(serde::Serialize, sqlx::FromRow)]
struct AccountStatus {
    username: String,
    account_type: String,
    status: String,
    timeout_until: Option<i64>,
    created_at: i64,
}

async fn account_status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(pool) = state.database.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "database_not_configured"})),
        )
            .into_response();
    };
    let user = match current_user(&headers, pool).await {
        Ok(Some(user)) => user,
        Ok(None) => {
            return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Sign in required."})))
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "account status session lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "account_status_failed"})),
            )
                .into_response();
        }
    };

    match sqlx::query_as::<_, AccountStatus>(
        "SELECT username, account_type, status, timeout_until, created_at FROM users WHERE id = $1",
    )
    .bind(user.id)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(account)) => Json(json!({"account": account})).into_response(),
        Ok(None) => (StatusCode::UNAUTHORIZED, Json(json!({"error": "Sign in required."})))
            .into_response(),
        Err(error) => {
            tracing::error!(%error, "account status lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "account_status_failed"})),
            )
                .into_response()
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/me", get(me))
        .route("/api/auth/logout", axum::routing::post(logout))
        .route("/api/account/status", get(account_status))
}
