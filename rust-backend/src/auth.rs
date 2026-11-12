use axum::{
    extract::State,
    http::{header::SET_COOKIE, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use sha2::{Digest, Sha256};
use uuid::Uuid;

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


#[derive(Deserialize)]
struct OAuthExchangeInput {
    code: String,
}

async fn exchange(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<OAuthExchangeInput>,
) -> Response {
    let code = input.code.trim();
    if code.len() != 64 || !code.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Sign-in code is invalid or expired."}))).into_response();
    }
    let Some(pool) = state.database.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "database_not_configured"}))).into_response();
    };
    let code_hash = hex::encode(Sha256::digest(code.as_bytes()));
    let now = chrono::Utc::now().timestamp();
    let user_id = match sqlx::query_scalar::<_, String>(
        "DELETE FROM oauth_login_codes WHERE code_hash = $1 AND expires_at >= $2 RETURNING user_id",
    )
    .bind(code_hash)
    .bind(now)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(user_id)) => user_id,
        Ok(None) => return (StatusCode::UNAUTHORIZED, Json(json!({"error": "Sign-in code is invalid or expired."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "OAuth login code exchange failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "oauth_exchange_failed"}))).into_response();
        }
    };
    let user = match sqlx::query_as::<_, AuthUser>(
        "SELECT id, username, account_type, status, timeout_until FROM users WHERE id = $1",
    )
    .bind(&user_id)
    .fetch_optional(pool)
    .await
    {
        Ok(Some(user)) if user.status == "active" => user,
        Ok(_) => return (StatusCode::FORBIDDEN, Json(json!({"error": "This MallowCord account is not active."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "OAuth exchange user lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "oauth_exchange_failed"}))).into_response();
        }
    };

    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let ip_hash = state.ip_hash_secret.as_ref().and_then(|secret| {
        headers
            .get("x-mallowcord-client-ip")
            .or_else(|| headers.get("cf-connecting-ip"))
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.trim().is_empty())
            .map(|ip| {
                let mut material = ip.trim().as_bytes().to_vec();
                material.extend_from_slice(secret.as_slice());
                hex::encode(Sha256::digest(material))
            })
    });
    let user_agent = headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if let Err(error) = sqlx::query(
        "INSERT INTO sessions(id, user_id, token_hash, created_at, expires_at, user_agent, ip_hash)
         VALUES($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&user.id)
    .bind(token_hash)
    .bind(now)
    .bind(now + 30 * 24 * 60 * 60)
    .bind(user_agent)
    .bind(ip_hash)
    .execute(pool)
    .await
    {
        tracing::error!(%error, "OAuth session creation failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "oauth_session_failed"}))).into_response();
    }

    let cookie = format!(
        "mallowcord_device={token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age={}",
        30 * 24 * 60 * 60
    );
    let mut response = Json(json!({
        "user": {
            "id": user.id,
            "username": user.username,
            "account_type": user.account_type
        }
    })).into_response();
    match HeaderValue::from_str(&cookie) {
        Ok(value) => {
            response.headers_mut().insert(SET_COOKIE, value);
            response
        }
        Err(error) => {
            tracing::error!(%error, "OAuth session cookie construction failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "oauth_session_failed"}))).into_response()
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
        .route("/api/auth/exchange", post(exchange))
        .route("/api/auth/me", get(me))
        .route("/api/auth/logout", axum::routing::post(logout))
        .route("/api/account/status", get(account_status))
}
