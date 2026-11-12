use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
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

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/auth/me", get(me))
}
