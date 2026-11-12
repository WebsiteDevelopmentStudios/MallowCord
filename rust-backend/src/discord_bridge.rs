use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::AppState;

fn unauthorized() -> Response {
    (StatusCode::UNAUTHORIZED, Json(json!({"error": "Integration authentication failed."})))
        .into_response()
}

fn require_bot(state: &AppState, headers: &HeaderMap) -> Result<PgPool, Box<Response>> {
    let Some(expected) = state.mallowbot_service_key.as_ref() else {
        return Err(Box::new(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "Mallow-Bot integration is not configured."})),
            )
                .into_response(),
        ));
    };
    let supplied = headers
        .get("x-mallowbot-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .as_bytes();
    if supplied.len() != expected.len()
        || supplied.ct_eq(expected.as_slice()).unwrap_u8() != 1
    {
        return Err(Box::new(unauthorized()));
    }
    let Some(pool) = state.database.as_ref() else {
        return Err(Box::new(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "database_not_configured"})),
            )
                .into_response(),
        ));
    };
    Ok(pool.clone())
}

fn valid_discord_id(value: &str) -> bool {
    (15..=22).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn guild_matches(state: &AppState, guild_id: &str) -> bool {
    guild_id == state.discord_guild_id.as_str()
}

async fn system_server(pool: &PgPool) -> Result<Option<(String, String)>, sqlx::Error> {
    sqlx::query_as::<_, (String, String)>(
        "SELECT id, owner_id FROM servers WHERE is_system = 1 ORDER BY created_at LIMIT 1",
    )
    .fetch_optional(pool)
    .await
}

async fn linked_user_id(
    pool: &PgPool,
    server_id: &str,
    discord_user_id: &str,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "SELECT user_id FROM discord_account_links
         WHERE discord_user_id = $1 AND server_id = $2
         UNION ALL
         SELECT user_id FROM discord_user_links
         WHERE discord_user_id = $1 AND server_id = $2
         LIMIT 1",
    )
    .bind(discord_user_id)
    .bind(server_id)
    .fetch_optional(pool)
    .await
}

#[derive(Deserialize)]
struct PresenceInput {
    guild_id: String,
    user_id: String,
    status: String,
}

async fn presence(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PresenceInput>,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    if !guild_matches(&state, &input.guild_id) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Guild is not linked."})))
            .into_response();
    }
    if !valid_discord_id(&input.user_id) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid Discord user ID."})))
            .into_response();
    }
    let server_id = match system_server(&pool).await {
        Ok(Some((id, _))) => id,
        Ok(None) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "Mallow Swamp could not be initialized."})),
            )
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "Discord presence server lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_presence_failed"})),
            )
                .into_response();
        }
    };
    let user_id = match linked_user_id(&pool, &server_id, &input.user_id).await {
        Ok(Some(user_id)) => user_id,
        Ok(None) => return Json(json!({"ok": true, "ignored": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "Discord presence account lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_presence_failed"})),
            )
                .into_response();
        }
    };
    let status = if ["online", "idle", "dnd", "offline"].contains(&input.status.as_str()) {
        input.status.as_str()
    } else {
        "offline"
    };
    match sqlx::query(
        "UPDATE user_profiles SET status = $1, updated_at = $2 WHERE user_id = $3",
    )
    .bind(status)
    .bind(now())
    .bind(&user_id)
    .execute(&pool)
    .await
    {
        Ok(_) => {
            let _ = state.realtime.send(json!({
                "type": "user.presence.updated",
                "server_id": server_id,
                "user_id": user_id,
                "status": status
            }));
            Json(json!({"ok": true})).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "Discord presence update failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_presence_failed"})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct DiscordMessageInput {
    guild_id: String,
    message_id: String,
    channel_id: String,
    author_id: String,
    content: String,
    display_name: Option<String>,
    username: Option<String>,
    avatar_url: Option<String>,
    timestamp: Option<i64>,
    mentioned_user_ids: Option<Vec<String>>,
}

async fn ensure_shadow_user(
    pool: &PgPool,
    server_id: &str,
    discord_user_id: &str,
) -> Result<String, sqlx::Error> {
    let username = format!("discord_{discord_user_id}");
    let username_key = username.to_ascii_lowercase();
    let existing = sqlx::query_scalar::<_, String>(
        "SELECT id FROM users WHERE username_key = $1",
    )
    .bind(&username_key)
    .fetch_optional(pool)
    .await?;

    let user_id = if let Some(id) = existing {
        id
    } else {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO users(id, username, username_key, account_type, status, created_at, updated_at)
             VALUES($1, $2, $3, 'basic', 'active', $4, $4)
             ON CONFLICT(username_key) DO NOTHING",
        )
        .bind(&id)
        .bind(&username)
        .bind(&username_key)
        .bind(now())
        .execute(pool)
        .await?;
        sqlx::query_scalar::<_, String>("SELECT id FROM users WHERE username_key = $1")
            .bind(&username_key)
            .fetch_one(pool)
            .await?
    };

    sqlx::query(
        "INSERT INTO discord_user_links(discord_user_id, server_id, user_id, updated_at)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(discord_user_id) DO UPDATE
         SET server_id = EXCLUDED.server_id, user_id = EXCLUDED.user_id, updated_at = EXCLUDED.updated_at",
    )
    .bind(discord_user_id)
    .bind(server_id)
    .bind(&user_id)
    .bind(now())
    .execute(pool)
    .await?;

    sqlx::query(
        "INSERT INTO memberships(server_id, user_id, joined_at)
         VALUES($1, $2, $3) ON CONFLICT(server_id, user_id) DO NOTHING",
    )
    .bind(server_id)
    .bind(&user_id)
    .bind(now())
    .execute(pool)
    .await?;

    let default_roles = sqlx::query_scalar::<_, String>(
        "SELECT id FROM roles WHERE server_id = $1 AND name IN ('@everyone', '@Member')",
    )
    .bind(server_id)
    .fetch_all(pool)
    .await?;
    for role_id in default_roles {
        sqlx::query(
            "INSERT INTO member_roles(server_id, user_id, role_id)
             VALUES($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(server_id)
        .bind(&user_id)
        .bind(role_id)
        .execute(pool)
        .await?;
    }

    Ok(user_id)
}

async fn discord_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<DiscordMessageInput>,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    if !guild_matches(&state, &input.guild_id) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Guild is not linked."})))
            .into_response();
    }
    let content = input.content.trim();
    if !valid_discord_id(&input.message_id)
        || !valid_discord_id(&input.channel_id)
        || !valid_discord_id(&input.author_id)
        || content.is_empty()
        || content.chars().count() > 4000
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Message payload is incomplete or invalid."})),
        )
            .into_response();
    }

    let server_id = match system_server(&pool).await {
        Ok(Some((id, _))) => id,
        Ok(None) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "Mallow Swamp could not be initialized."})),
            )
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "Discord message server lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_message_failed"})),
            )
                .into_response();
        }
    };

    match sqlx::query_scalar::<_, String>(
        "SELECT mallow_message_id FROM discord_message_links WHERE discord_message_id = $1",
    )
    .bind(&input.message_id)
    .fetch_optional(&pool)
    .await
    {
        Ok(Some(_)) => return Json(json!({"ok": true, "duplicate": true})).into_response(),
        Ok(None) => {}
        Err(error) => {
            tracing::error!(%error, "Discord message duplicate lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_message_failed"})),
            )
                .into_response();
        }
    }

    let channel_id = match sqlx::query_scalar::<_, String>(
        "SELECT mallow_channel_id FROM discord_channel_links
         WHERE discord_channel_id = $1 AND server_id = $2",
    )
    .bind(&input.channel_id)
    .bind(&server_id)
    .fetch_optional(&pool)
    .await
    {
        Ok(Some(id)) => id,
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "Discord channel has not been synchronized."})),
            )
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "Discord channel mapping lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_message_failed"})),
            )
                .into_response();
        }
    };

    let user_id = match linked_user_id(&pool, &server_id, &input.author_id).await {
        Ok(Some(id)) => id,
        Ok(None) => match ensure_shadow_user(&pool, &server_id, &input.author_id).await {
            Ok(id) => id,
            Err(error) => {
                tracing::error!(%error, "Discord shadow account creation failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "discord_message_failed"})),
                )
                    .into_response();
            }
        },
        Err(error) => {
            tracing::error!(%error, "Discord author lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_message_failed"})),
            )
                .into_response();
        }
    };

    let display_name = input
        .display_name
        .as_deref()
        .or(input.username.as_deref())
        .unwrap_or("Discord user")
        .trim();
    let display_name: String = display_name.chars().take(32).collect();
    let avatar_url = input
        .avatar_url
        .as_deref()
        .filter(|value| value.starts_with("https://") && value.len() <= 1000);
    if let Err(error) = sqlx::query(
        "INSERT INTO user_profiles(user_id, display_name, avatar_url, updated_at)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url,
           updated_at = EXCLUDED.updated_at",
    )
    .bind(&user_id)
    .bind(&display_name)
    .bind(avatar_url)
    .bind(now())
    .execute(&pool)
    .await
    {
        tracing::error!(%error, "Discord author profile update failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_message_failed"})),
        )
            .into_response();
    }

    let message_id = Uuid::new_v4().to_string();
    let created_at = input.timestamp.filter(|value| *value > 0).unwrap_or_else(now);
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "Discord message transaction could not start");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_message_failed"})),
            )
                .into_response();
        }
    };
    if let Err(error) = sqlx::query(
        "INSERT INTO messages(id, channel_id, author_id, content, created_at)
         VALUES($1, $2, $3, $4, $5)",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .bind(&user_id)
    .bind(content)
    .bind(created_at)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "Discord message insert failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_message_failed"})),
        )
            .into_response();
    }

    let mapping = sqlx::query_scalar::<_, String>(
        "INSERT INTO discord_message_links(discord_message_id, mallow_message_id, discord_channel_id)
         VALUES($1, $2, $3)
         ON CONFLICT(discord_message_id) DO NOTHING
         RETURNING discord_message_id",
    )
    .bind(&input.message_id)
    .bind(&message_id)
    .bind(&input.channel_id)
    .fetch_optional(&mut *tx)
    .await;
    match mapping {
        Ok(Some(_)) => {}
        Ok(None) => {
            let _ = tx.rollback().await;
            return Json(json!({"ok": true, "duplicate": true})).into_response();
        }
        Err(error) => {
            tracing::error!(%error, "Discord message mapping insert failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_message_failed"})),
            )
                .into_response();
        }
    }

    for mentioned_id in input.mentioned_user_ids.unwrap_or_default().into_iter().take(100) {
        if !valid_discord_id(&mentioned_id) || mentioned_id == input.author_id {
            continue;
        }
        let target = linked_user_id(&pool, &server_id, &mentioned_id).await;
        let Ok(Some(target_user_id)) = target else {
            continue;
        };
        if let Err(error) = sqlx::query(
            "INSERT INTO message_notifications(id, user_id, server_id, channel_id, message_id, kind, created_at)
             VALUES($1, $2, $3, $4, $5, 'mention', $6)
             ON CONFLICT(user_id, message_id, kind) DO NOTHING",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(target_user_id)
        .bind(&server_id)
        .bind(&channel_id)
        .bind(&message_id)
        .bind(now())
        .execute(&mut *tx)
        .await
        {
            tracing::error!(%error, "Discord mention notification insert failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_message_failed"})),
            )
                .into_response();
        }
    }

    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "Discord message transaction commit failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_message_failed"})),
        )
            .into_response();
    }

    let message = json!({
        "id": message_id,
        "content": content,
        "created_at": created_at,
        "author_id": user_id,
        "username": input.username.unwrap_or_else(|| format!("discord_{}", input.author_id)),
        "display_name": display_name
    });
    let _ = state.realtime.send(json!({
        "type": "message.created",
        "server_id": server_id,
        "channel_id": channel_id,
        "message": message.clone()
    }));
    (StatusCode::CREATED, Json(json!({"ok": true, "message_id": message_id}))).into_response()
}

#[derive(Deserialize)]
struct LinkClaimInput {
    code: String,
    discord_user_id: String,
}

async fn claim_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<LinkClaimInput>,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    let code: String = input
        .code
        .chars()
        .filter(|value| value.is_ascii_alphanumeric())
        .map(|value| value.to_ascii_uppercase())
        .collect();
    if code.len() != 8 || !valid_discord_id(&input.discord_user_id) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid link code."})))
            .into_response();
    }
    let server_id = match system_server(&pool).await {
        Ok(Some((id, _))) => id,
        Ok(None) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "Mallow Swamp could not be initialized."})),
            )
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "Discord link server lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_link_failed"})),
            )
                .into_response();
        }
    };
    let code_hash = hex::encode(Sha256::digest(code.as_bytes()));
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "Discord link transaction could not start");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_link_failed"})),
            )
                .into_response();
        }
    };
    let link = sqlx::query_as::<_, (String, i64)>(
        "SELECT user_id, expires_at FROM discord_link_codes WHERE code_hash = $1 FOR UPDATE",
    )
    .bind(&code_hash)
    .fetch_optional(&mut *tx)
    .await;
    let (user_id, expires_at) = match link {
        Ok(Some(value)) if value.1 >= now() => value,
        Ok(_) => {
            let _ = tx.rollback().await;
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "Link code is invalid or expired."})),
            )
                .into_response();
        }
        Err(error) => {
            tracing::error!(%error, "Discord link code lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_link_failed"})),
            )
                .into_response();
        }
    };
    let existing = sqlx::query_scalar::<_, String>(
        "SELECT user_id FROM discord_account_links
         WHERE discord_user_id = $1 AND server_id = $2",
    )
    .bind(&input.discord_user_id)
    .bind(&server_id)
    .fetch_optional(&mut *tx)
    .await;
    match existing {
        Ok(Some(existing_user)) if existing_user != user_id => {
            let _ = tx.rollback().await;
            return (
                StatusCode::CONFLICT,
                Json(json!({"error": "This Discord account is already linked to another MallowCord account."})),
            )
                .into_response();
        }
        Ok(_) => {}
        Err(error) => {
            tracing::error!(%error, "Discord existing link lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_link_failed"})),
            )
                .into_response();
        }
    };
    let other = sqlx::query_scalar::<_, String>(
        "SELECT discord_user_id FROM discord_account_links
         WHERE user_id = $1 AND server_id = $2",
    )
    .bind(&user_id)
    .bind(&server_id)
    .fetch_optional(&mut *tx)
    .await;
    match other {
        Ok(Some(other_discord_id)) if other_discord_id != input.discord_user_id => {
            let _ = tx.rollback().await;
            return (
                StatusCode::CONFLICT,
                Json(json!({"error": "This MallowCord account is already linked to another Discord account."})),
            )
                .into_response();
        }
        Ok(_) => {}
        Err(error) => {
            tracing::error!(%error, "Discord other-account lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_link_failed"})),
            )
                .into_response();
        }
    };
    let shadow = sqlx::query_scalar::<_, String>(
        "SELECT user_id FROM discord_user_links
         WHERE discord_user_id = $1 AND server_id = $2",
    )
    .bind(&input.discord_user_id)
    .bind(&server_id)
    .fetch_optional(&mut *tx)
    .await;
    let shadow_user_id = match shadow {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(%error, "Discord shadow link lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_link_failed"})),
            )
                .into_response();
        }
    };

    let updated = sqlx::query(
        "INSERT INTO discord_account_links(discord_user_id, server_id, user_id, updated_at)
         VALUES($1, $2, $3, $4)
         ON CONFLICT(discord_user_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, updated_at = EXCLUDED.updated_at",
    )
    .bind(&input.discord_user_id)
    .bind(&server_id)
    .bind(&user_id)
    .bind(now())
    .execute(&mut *tx)
    .await;
    if let Err(error) = updated {
        tracing::error!(%error, "Discord account link insert failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_link_failed"})),
        )
            .into_response();
    }
    if let Err(error) = sqlx::query(
        "INSERT INTO memberships(server_id, user_id, joined_at)
         VALUES($1, $2, $3) ON CONFLICT(server_id, user_id) DO NOTHING",
    )
    .bind(&server_id)
    .bind(&user_id)
    .bind(now())
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "Discord linked account membership insert failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_link_failed"})),
        )
            .into_response();
    }
    if let Some(shadow_user_id) = shadow_user_id.filter(|shadow| shadow != &user_id) {
        if let Err(error) = sqlx::query(
            "INSERT INTO member_roles(server_id, user_id, role_id)
             SELECT server_id, $1, role_id FROM member_roles
             WHERE server_id = $2 AND user_id = $3
             ON CONFLICT DO NOTHING",
        )
        .bind(&user_id)
        .bind(&server_id)
        .bind(&shadow_user_id)
        .execute(&mut *tx)
        .await
        {
            tracing::error!(%error, "Discord shadow role migration failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_link_failed"})),
            )
                .into_response();
        }
        let _ = sqlx::query(
            "UPDATE channel_permissions SET target_id = $1
             WHERE channel_id IN (SELECT id FROM channels WHERE server_id = $2)
               AND target_type = 'user' AND target_id = $3",
        )
        .bind(&user_id)
        .bind(&server_id)
        .bind(&shadow_user_id)
        .execute(&mut *tx)
        .await;
        if let Err(error) = sqlx::query(
            "DELETE FROM memberships WHERE server_id = $1 AND user_id = $2",
        )
        .bind(&server_id)
        .bind(&shadow_user_id)
        .execute(&mut *tx)
        .await
        {
            tracing::error!(%error, "Discord shadow membership cleanup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_link_failed"})),
            )
                .into_response();
        }
    }
    if let Err(error) = sqlx::query("DELETE FROM discord_link_codes WHERE code_hash = $1")
        .bind(&code_hash)
        .execute(&mut *tx)
        .await
    {
        tracing::error!(%error, "Discord link code deletion failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_link_failed"})),
        )
            .into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "Discord link transaction commit failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_link_failed"})),
        )
            .into_response();
    }
    let _ = expires_at;
    Json(json!({"ok": true, "linked": true})).into_response()
}

#[derive(Serialize, FromRow)]
struct OutboxMessage {
    id: String,
    discord_channel_id: String,
    username: String,
    avatar_url: Option<String>,
    content: String,
    message_id: String,
}

async fn outbox(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    match sqlx::query_as::<_, OutboxMessage>(
        "SELECT id, discord_channel_id, username, avatar_url, content, message_id
         FROM discord_outbox WHERE processed_at IS NULL
         ORDER BY created_at LIMIT 30",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(events) => Json(json!({"events": events})).into_response(),
        Err(error) => {
            tracing::error!(%error, "Discord outbox lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_outbox_failed"})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct OutboxAckInput {
    discord_message_id: Option<String>,
}

async fn acknowledge_outbox(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(outbox_id): Path<String>,
    Json(input): Json<OutboxAckInput>,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    let discord_message_id = input
        .discord_message_id
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(32).collect::<String>());
    match sqlx::query(
        "UPDATE discord_outbox SET processed_at = $1, discord_message_id = $2 WHERE id = $3",
    )
    .bind(now())
    .bind(discord_message_id)
    .bind(outbox_id)
    .execute(&pool)
    .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "Discord outbox acknowledgement failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_outbox_failed"})),
            )
                .into_response()
        }
    }
}

#[derive(Serialize, FromRow)]
struct CommandJob {
    id: String,
    channel_id: String,
    discord_user_id: String,
    content: String,
    discord_channel_id: String,
}

async fn next_commands(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    match sqlx::query_as::<_, CommandJob>(
        "WITH candidates AS (
             SELECT j.id
             FROM discord_command_jobs j
             WHERE (j.status = 'queued' OR (j.status = 'processing' AND j.processed_at < $1))
               AND EXISTS (
                   SELECT 1 FROM discord_channel_links cl
                   WHERE cl.mallow_channel_id = j.channel_id AND cl.server_id = j.server_id
               )
             ORDER BY j.created_at
             LIMIT 5
             FOR UPDATE SKIP LOCKED
         ),
         claimed AS (
             UPDATE discord_command_jobs j
             SET status = 'processing', processed_at = $2
             FROM candidates c
             WHERE j.id = c.id
             RETURNING j.id, j.server_id, j.channel_id, j.discord_user_id, j.content
         )
         SELECT claimed.id, claimed.channel_id, claimed.discord_user_id,
                claimed.content, cl.discord_channel_id
         FROM claimed
         JOIN discord_channel_links cl
           ON cl.mallow_channel_id = claimed.channel_id AND cl.server_id = claimed.server_id",
    )
    .bind(now() - 120)
    .bind(now())
    .fetch_all(&pool)
    .await
    {
        Ok(jobs) => Json(json!({"jobs": jobs})).into_response(),
        Err(error) => {
            tracing::error!(%error, "Discord command queue lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_commands_failed"})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct CommandResultInput {
    id: String,
    #[serde(default)]
    content: String,
}

async fn command_result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<CommandResultInput>,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    let content = input.content.trim();
    if content.chars().count() > 4000 || input.id.is_empty() || input.id.len() > 128 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid command result."})),
        )
            .into_response();
    }
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "Discord command result transaction failed to start");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_commands_failed"})),
            )
                .into_response();
        }
    };
    let job = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT channel_id, user_id FROM discord_command_jobs
         WHERE id = $1 AND status = 'processing' FOR UPDATE",
    )
    .bind(&input.id)
    .fetch_optional(&mut *tx)
    .await;
    let (channel_id, source_user_id) = match job {
        Ok(Some(job)) => job,
        Ok(None) => {
            let _ = tx.rollback().await;
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "Command job not found."})),
            )
                .into_response();
        }
        Err(error) => {
            tracing::error!(%error, "Discord command job lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_commands_failed"})),
            )
                .into_response();
        }
    };
    if !content.is_empty() {
        let avatar_url = state
            .mallowbot_icon_url
            .as_deref()
            .unwrap_or("https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png");
        if let Err(error) = sqlx::query(
            "INSERT INTO bot_messages(id, channel_id, source_user_id, username, avatar_url, content, created_at)
             VALUES($1, $2, $3, 'Mallow Bot', $4, $5, $6)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&channel_id)
        .bind(source_user_id)
        .bind(avatar_url)
        .bind(content)
        .bind(now())
        .execute(&mut *tx)
        .await
        {
            tracing::error!(%error, "Discord bot message insert failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_commands_failed"})),
            )
                .into_response();
        }
    }
    if let Err(error) = sqlx::query(
        "UPDATE discord_command_jobs SET status = 'done', processed_at = $1 WHERE id = $2",
    )
    .bind(now())
    .bind(&input.id)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "Discord command job completion failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_commands_failed"})),
        )
            .into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "Discord command result commit failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "discord_commands_failed"})),
        )
            .into_response();
    }
    Json(json!({"ok": true})).into_response()
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/integrations/mallowbot/discord/presence", post(presence))
        .route("/api/integrations/mallowbot/discord/messages", post(discord_message))
        .route("/api/integrations/mallowbot/discord/link/claim", post(claim_link))
        .route(
            "/api/integrations/mallowbot/discord/commands/next",
            get(next_commands),
        )
        .route(
            "/api/integrations/mallowbot/discord/commands/result",
            post(command_result),
        )
        .route("/api/integrations/mallowbot/discord/outbox", get(outbox))
        .route(
            "/api/integrations/mallowbot/discord/outbox/{outbox_id}/ack",
            post(acknowledge_outbox),
        )
}
