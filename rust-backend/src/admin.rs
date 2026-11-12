use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use uuid::Uuid;
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


#[derive(Deserialize)]
struct IpBanInput {
    ip: String,
    reason: Option<String>,
}

async fn create_ip_ban(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<IpBanInput>,
) -> Response {
    let (pool, user) = match require_owner(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let ip = input.ip.trim();
    if ip.parse::<std::net::IpAddr>().is_err() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "A valid IP address is required."})))
            .into_response();
    }
    let Some(secret) = state.ip_hash_secret.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "IP_HASH_SECRET is not configured."})),
        )
            .into_response();
    };
    let mut material = ip.as_bytes().to_vec();
    material.extend_from_slice(secret.as_slice());
    let ip_hash = hex::encode(Sha256::digest(material));
    let reason: String = input
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Global IP ban")
        .chars()
        .take(300)
        .collect();
    let timestamp = chrono::Utc::now().timestamp();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "global IP ban transaction could not start");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "ip_ban_failed"})),
            )
                .into_response();
        }
    };
    if let Err(error) = sqlx::query(
        "INSERT INTO bans(id, ip_hash, reason, created_by, created_at)
         VALUES($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&ip_hash)
    .bind(&reason)
    .bind(&user.id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "global IP ban insert failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "ip_ban_failed"})),
        )
            .into_response();
    }
    if let Err(error) = sqlx::query(
        "INSERT INTO audit_logs(id, actor_id, target_user_id, action, details, created_at)
         VALUES($1, $2, NULL, 'global_ip_ban', NULL, $3)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&user.id)
    .bind(timestamp)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "global IP ban audit insert failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "ip_ban_audit_failed"})),
        )
            .into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "global IP ban transaction commit failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "ip_ban_failed"})),
        )
            .into_response();
    }
    Json(json!({"ok": true})).into_response()
}


#[derive(serde::Serialize, sqlx::FromRow)]
struct WorkerErrorLog {
    id: String,
    method: String,
    path: String,
    message: String,
    stack: Option<String>,
    origin: Option<String>,
    created_at: i64,
}

async fn list_worker_errors(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, _) = match require_owner(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };

    match sqlx::query_as::<_, WorkerErrorLog>(
        "SELECT id, method, path, message, stack, origin, created_at
         FROM worker_error_logs ORDER BY created_at DESC LIMIT 200",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(errors) => Json(json!({"errors": errors})).into_response(),
        Err(error) => {
            tracing::error!(%error, "Worker error log lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "worker_error_log_lookup_failed"})),
            )
                .into_response()
        }
    }
}

async fn clear_worker_errors(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, _) = match require_owner(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };

    match sqlx::query("DELETE FROM worker_error_logs")
        .execute(&pool)
        .await
    {
        Ok(result) => Json(json!({
            "ok": true,
            "deleted": result.rows_affected()
        }))
        .into_response(),
        Err(error) => {
            tracing::error!(%error, "Worker error log clear failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "worker_error_log_clear_failed"})),
            )
                .into_response()
        }
    }
}


#[derive(serde::Serialize, sqlx::FromRow)]
struct AdminUserRow {
    id: String,
    username: String,
    account_type: String,
    status: String,
    timeout_until: Option<i64>,
    created_at: i64,
}

async fn list_admin_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, _) = match require_owner(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };

    match sqlx::query_as::<_, AdminUserRow>(
        "SELECT id, username, account_type, status, timeout_until, created_at
         FROM users ORDER BY created_at DESC LIMIT 500",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(users) => Json(json!({"users": users})).into_response(),
        Err(error) => {
            tracing::error!(%error, "admin user list lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "admin_user_list_failed"})),
            )
                .into_response()
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/audit", get(audit_events))
        .route("/api/admin/users", get(list_admin_users))
        .route("/api/admin/errors", get(list_worker_errors).delete(clear_worker_errors))
        .route("/api/admin/ip-ban", axum::routing::post(create_ip_ban))
}
