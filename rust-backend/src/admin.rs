use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use sqlx::PgPool;

use crate::{
    auth::{current_user, AuthUser},
    AppState,
};

async fn require_owner(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(PgPool, AuthUser), Box<Response>> {
    let Some(pool) = state.database.as_ref() else {
        return Err(Box::new((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "database_not_configured"})),
        )
            .into_response()));
    };

    match current_user(headers, pool).await {
        Ok(Some(user)) if user.account_type == "owner" => Ok((pool.clone(), user)),
        Ok(Some(_)) => Err(Box::new((
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Owner access required."})),
        )
            .into_response())),
        Ok(None) => Err(Box::new((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Sign in required."})),
        )
            .into_response())),
        Err(error) => {
            tracing::error!(%error, "admin session lookup failed");
            Err(Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "admin_authentication_failed"})),
            )
                .into_response()))
        }
    }
}

async fn audit_events(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, _) = match require_owner(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };

    match sqlx::query_as::<_, (String, Option<String>, Option<String>, String, Option<String>, i64)>(
        "SELECT id, actor_id, target_user_id, action, details, created_at
         FROM audit_logs ORDER BY created_at DESC LIMIT 100",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(rows) => {
            let events: Vec<_> = rows
                .into_iter()
                .map(|(id, actor_id, target_user_id, action, details, created_at)| {
                    json!({
                        "id": id,
                        "actor_id": actor_id,
                        "target_user_id": target_user_id,
                        "action": action,
                        "details": details,
                        "created_at": created_at
                    })
                })
                .collect();
            Json(json!({"events": events})).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "admin audit log lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "audit_lookup_failed"})),
            )
                .into_response()
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/admin/audit", get(audit_events))
}
