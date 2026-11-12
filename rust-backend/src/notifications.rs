use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use sqlx::{FromRow, PgPool};

use crate::{
    auth::{current_user, AuthUser},
    AppState,
};

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

async fn require_user(
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
        Ok(Some(user)) => {
            if user.status == "timed_out" && user.timeout_until.unwrap_or(0) > now() {
                return Err(Box::new((
                    StatusCode::FORBIDDEN,
                    Json(json!({"error": "Your account is timed out."})),
                )
                    .into_response()));
            }
            Ok((pool.clone(), user))
        }
        Ok(None) => Err(Box::new((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Sign in required."})),
        )
            .into_response())),
        Err(error) => {
            tracing::error!(%error, "notification API session lookup failed");
            Err(Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            )
                .into_response()))
        }
    }
}

#[derive(FromRow)]
struct UnreadGroup {
    server_id: String,
    channel_id: String,
    count: i64,
}

async fn list_notifications(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let rows = sqlx::query_as::<_, UnreadGroup>(
        "SELECT mn.server_id, mn.channel_id, COUNT(*)::bigint AS count
         FROM message_notifications mn
         WHERE mn.user_id = $1 AND mn.seen_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_notification_settings ns
             WHERE ns.user_id = mn.user_id AND ns.muted = 1
               AND (
                 (ns.scope_type = 'server' AND ns.scope_id = mn.server_id)
                 OR (ns.scope_type = 'channel' AND ns.scope_id = mn.channel_id)
               )
           )
         GROUP BY mn.server_id, mn.channel_id",
    )
    .bind(&user.id)
    .fetch_all(&pool)
    .await;
    match rows {
        Ok(rows) => {
            let total: i64 = rows.iter().map(|row| row.count).sum();
            Json(json!({"unread": rows, "total": total})).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "notification list query failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "notifications_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct ReadChannelInput {
    channel_id: String,
}

async fn mark_channel_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ReadChannelInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let channel_id = input.channel_id.trim();
    let access = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM channels c
         JOIN memberships m ON m.server_id = c.server_id
         WHERE c.id = $1 AND m.user_id = $2",
    )
    .bind(channel_id)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    match access {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::FORBIDDEN, Json(json!({"error": "You cannot mark this channel as read."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "channel notification access check failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "notifications_update_failed"}))).into_response();
        }
    }
    match sqlx::query(
        "UPDATE message_notifications SET seen_at = $1
         WHERE user_id = $2 AND channel_id = $3 AND seen_at IS NULL",
    )
    .bind(now())
    .bind(&user.id)
    .bind(channel_id)
    .execute(&pool)
    .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "mark channel read failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "notifications_update_failed"}))).into_response()
        }
    }
}

#[derive(FromRow, serde::Serialize)]
struct NotificationSetting {
    scope_type: String,
    scope_id: String,
    muted: i64,
}

async fn get_notification_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match sqlx::query_as::<_, NotificationSetting>(
        "SELECT scope_type, scope_id, muted FROM user_notification_settings
         WHERE user_id = $1 AND muted = 1",
    )
    .bind(&user.id)
    .fetch_all(&pool)
    .await
    {
        Ok(settings) => Json(json!({"settings": settings})).into_response(),
        Err(error) => {
            tracing::error!(%error, "notification settings lookup failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "notification_settings_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct UpdateNotificationSettingInput {
    scope_type: String,
    scope_id: String,
    muted: bool,
}

async fn update_notification_setting(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdateNotificationSettingInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let scope = input.scope_type.as_str();
    let scope_id = input.scope_id.trim();
    if !["server", "channel"].contains(&scope) || scope_id.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid notification setting."}))).into_response();
    }
    let access = if scope == "server" {
        sqlx::query_scalar::<_, i32>(
            "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
        )
        .bind(scope_id)
        .bind(&user.id)
        .fetch_optional(&pool)
        .await
    } else {
        sqlx::query_scalar::<_, i32>(
            "SELECT 1 FROM channels c
             JOIN memberships m ON m.server_id = c.server_id
             WHERE c.id = $1 AND m.user_id = $2",
        )
        .bind(scope_id)
        .bind(&user.id)
        .fetch_optional(&pool)
        .await
    };
    match access {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::FORBIDDEN, Json(json!({"error": "You cannot change notifications for this item."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "notification setting access check failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "notification_settings_failed"}))).into_response();
        }
    }
    let muted = if input.muted { 1_i64 } else { 0_i64 };
    match sqlx::query(
        "INSERT INTO user_notification_settings(user_id, scope_type, scope_id, muted, updated_at)
         VALUES($1, $2, $3, $4, $5)
         ON CONFLICT(user_id, scope_type, scope_id)
         DO UPDATE SET muted = EXCLUDED.muted, updated_at = EXCLUDED.updated_at",
    )
    .bind(&user.id)
    .bind(scope)
    .bind(scope_id)
    .bind(muted)
    .bind(now())
    .execute(&pool)
    .await
    {
        Ok(_) => Json(json!({"ok": true, "muted": input.muted})).into_response(),
        Err(error) => {
            tracing::error!(%error, "notification setting update failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "notification_settings_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct ClearNotificationsInput {
    scope_type: String,
    scope_id: String,
}

async fn clear_notifications(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ClearNotificationsInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let scope = input.scope_type.as_str();
    let scope_id = input.scope_id.trim();
    if !["server", "channel"].contains(&scope) || scope_id.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid notification target."}))).into_response();
    }
    let access = if scope == "server" {
        sqlx::query_scalar::<_, i32>(
            "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
        )
        .bind(scope_id)
        .bind(&user.id)
        .fetch_optional(&pool)
        .await
    } else {
        sqlx::query_scalar::<_, i32>(
            "SELECT 1 FROM channels c
             JOIN memberships m ON m.server_id = c.server_id
             WHERE c.id = $1 AND m.user_id = $2",
        )
        .bind(scope_id)
        .bind(&user.id)
        .fetch_optional(&pool)
        .await
    };
    match access {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::FORBIDDEN, Json(json!({"error": "You cannot clear notifications for this item."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "notification clear access check failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "notifications_update_failed"}))).into_response();
        }
    }
    let sql = if scope == "server" {
        "UPDATE message_notifications SET seen_at = $1 WHERE user_id = $2 AND server_id = $3 AND seen_at IS NULL"
    } else {
        "UPDATE message_notifications SET seen_at = $1 WHERE user_id = $2 AND channel_id = $3 AND seen_at IS NULL"
    };
    match sqlx::query(sql)
        .bind(now())
        .bind(&user.id)
        .bind(scope_id)
        .execute(&pool)
        .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "notification clear failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "notifications_update_failed"}))).into_response()
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/notifications", get(list_notifications))
        .route("/api/notifications/read", post(mark_channel_read))
        .route("/api/notifications/clear", post(clear_notifications))
        .route(
            "/api/notification-settings",
            get(get_notification_settings).post(update_notification_setting),
        )
}
