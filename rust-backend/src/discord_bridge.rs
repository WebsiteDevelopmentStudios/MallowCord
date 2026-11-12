use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::collections::HashMap;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::{auth::{current_user, AuthUser}, server::channel_permission_allowed, AppState};

async fn require_web_user(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(PgPool, AuthUser), Box<Response>> {
    let Some(pool) = state.database.as_ref() else {
        return Err(Box::new((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "database_not_configured"})),
        ).into_response()));
    };
    match current_user(headers, pool).await {
        Ok(Some(user)) if user.status != "timed_out" || user.timeout_until.unwrap_or(0) <= now() => {
            Ok((pool.clone(), user))
        }
        Ok(Some(_)) => Err(Box::new((
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Your account is timed out."})),
        ).into_response())),
        Ok(None) => Err(Box::new((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Sign in required."})),
        ).into_response())),
        Err(error) => {
            tracing::error!(%error, "Discord account session lookup failed");
            Err(Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            ).into_response()))
        }
    }
}

async fn discord_link_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_web_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let server_id = match system_server(&pool).await {
        Ok(Some((id, _))) => id,
        Ok(None) => return Json(json!({"linked": false, "discord_user_id": null})).into_response(),
        Err(error) => {
            tracing::error!(%error, "Discord link status server lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "discord_link_failed"}))).into_response();
        }
    };
    match sqlx::query_scalar::<_, String>(
        "SELECT discord_user_id FROM discord_account_links WHERE user_id = $1 AND server_id = $2",
    )
    .bind(&user.id)
    .bind(&server_id)
    .fetch_optional(&pool)
    .await
    {
        Ok(linked) => Json(json!({"linked": linked.is_some(), "discord_user_id": linked})).into_response(),
        Err(error) => {
            tracing::error!(%error, "Discord link status lookup failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "discord_link_failed"}))).into_response()
        }
    }
}

async fn discord_link_start(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_web_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let server_id = match system_server(&pool).await {
        Ok(Some((id, _))) => id,
        Ok(None) => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Mallow Swamp is not initialized."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "Discord link start server lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "discord_link_failed"}))).into_response();
        }
    };
    let linked = sqlx::query_scalar::<_, String>(
        "SELECT discord_user_id FROM discord_account_links WHERE user_id = $1 AND server_id = $2",
    )
    .bind(&user.id)
    .bind(&server_id)
    .fetch_optional(&pool)
    .await;
    match linked {
        Ok(Some(_)) => return (StatusCode::CONFLICT, Json(json!({"error": "A Discord account is already linked."}))).into_response(),
        Ok(None) => {}
        Err(error) => {
            tracing::error!(%error, "Discord existing account link lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "discord_link_failed"}))).into_response();
        }
    };

    const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let random = Uuid::new_v4();
    let code: String = random.as_bytes()[..8]
        .iter()
        .map(|byte| ALPHABET[(*byte % 32) as usize] as char)
        .collect();
    let code_hash = hex::encode(Sha256::digest(code.as_bytes()));
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "Discord link code transaction failed to start");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "discord_link_failed"}))).into_response();
        }
    };
    if let Err(error) = sqlx::query("DELETE FROM discord_link_codes WHERE user_id = $1")
        .bind(&user.id)
        .execute(&mut *tx)
        .await
    {
        tracing::error!(%error, "old Discord link code cleanup failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "discord_link_failed"}))).into_response();
    }
    if let Err(error) = sqlx::query(
        "INSERT INTO discord_link_codes(code_hash, user_id, expires_at, created_at) VALUES($1, $2, $3, $4)",
    )
    .bind(code_hash)
    .bind(&user.id)
    .bind(now() + 600)
    .bind(now())
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "Discord link code insert failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "discord_link_failed"}))).into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "Discord link code transaction commit failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "discord_link_failed"}))).into_response();
    }
    Json(json!({
        "code": code,
        "expires_in": 600,
        "instructions": format!("Send a private DM to Mallow Bot with -mb link {code}")
    })).into_response()
}

#[derive(Deserialize)]
struct BotCommandInput {
    channel_id: String,
    content: String,
}

async fn bot_command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<BotCommandInput>,
) -> Response {
    let (pool, user) = match require_web_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let channel_id = input.channel_id.trim();
    let content = input.content.trim();
    if channel_id.is_empty() || content.is_empty() || content.chars().count() > 4000 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "A channel and command are required."}))).into_response();
    }
    let command = match content.get(..3) {
        Some(prefix) if prefix.eq_ignore_ascii_case("-mb") || prefix.eq_ignore_ascii_case("/mb") => &content[3..],
        _ => return (StatusCode::BAD_REQUEST, Json(json!({"error": "Use -mb help to see the Mallow-Bot command list."}))).into_response(),
    };
    let command_name = command.split_whitespace().next().unwrap_or_default();
    if command_name.is_empty() || !command_name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Use -mb help to see the Mallow-Bot command list."}))).into_response();
    }

    let server_id = match sqlx::query_scalar::<_, String>(
        "SELECT c.server_id FROM channels c
         JOIN memberships m ON m.server_id = c.server_id
         WHERE c.id = $1 AND m.user_id = $2 AND c.kind = 'text'",
    )
    .bind(channel_id)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await
    {
        Ok(Some(id)) => id,
        Ok(None) => return (StatusCode::FORBIDDEN, Json(json!({"error": "You cannot run bot commands in this channel."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "bot command channel lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
        }
    };
    for permission in ["view_channel", "send_messages"] {
        match channel_permission_allowed(&pool, &user.id, channel_id, permission).await {
            Ok(true) => {}
            Ok(false) => return (StatusCode::FORBIDDEN, Json(json!({"error": "You cannot run bot commands in this channel."}))).into_response(),
            Err(error) => {
                tracing::error!(%error, permission, "bot command permission lookup failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
            }
        }
    }

    let official_server_id = match system_server(&pool).await {
        Ok(Some((id, _))) => id,
        Ok(None) => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Mallow Swamp is not initialized."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "bot command official server lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
        }
    };
    let discord_user_id = match sqlx::query_scalar::<_, String>(
        "SELECT discord_user_id FROM discord_account_links WHERE user_id = $1 AND server_id = $2",
    )
    .bind(&user.id)
    .bind(&official_server_id)
    .fetch_optional(&pool)
    .await
    {
        Ok(Some(id)) => id,
        Ok(None) => return (StatusCode::FORBIDDEN, Json(json!({"error": "Link your Discord account in User Settings → Discord Link before running Mallow-Bot commands."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "bot command Discord link lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
        }
    };
    let mapped = sqlx::query_scalar::<_, String>(
        "SELECT discord_channel_id FROM discord_channel_links WHERE mallow_channel_id = $1 AND server_id = $2",
    )
    .bind(channel_id)
    .bind(&official_server_id)
    .fetch_optional(&pool)
    .await;
    match mapped {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "Mallow-Bot commands are only available in channels synchronized with the official Discord server."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "bot command channel mapping lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
        }
    };
    let pending = match sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*)::bigint FROM discord_command_jobs WHERE user_id = $1 AND status IN ('queued', 'processing')",
    )
    .bind(&user.id)
    .fetch_one(&pool)
    .await
    {
        Ok(count) => count,
        Err(error) => {
            tracing::error!(%error, "pending bot command count failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
        }
    };
    if pending >= 5 {
        return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error": "You have too many commands waiting. Try again in a moment."}))).into_response();
    }

    let message_id = Uuid::new_v4().to_string();
    let job_id = Uuid::new_v4().to_string();
    let created_at = now();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "bot command transaction failed to start");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
        }
    };
    if let Err(error) = sqlx::query(
        "INSERT INTO messages(id, channel_id, author_id, content, created_at) VALUES($1, $2, $3, $4, $5)",
    )
    .bind(&message_id)
    .bind(channel_id)
    .bind(&user.id)
    .bind(content)
    .bind(created_at)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "bot command message insert failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
    }
    if let Err(error) = sqlx::query(
        "INSERT INTO discord_command_jobs(id, server_id, channel_id, user_id, discord_user_id, content, status, created_at)
         VALUES($1, $2, $3, $4, $5, $6, 'queued', $7)",
    )
    .bind(&job_id)
    .bind(&official_server_id)
    .bind(channel_id)
    .bind(&user.id)
    .bind(&discord_user_id)
    .bind(content)
    .bind(created_at)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "bot command queue insert failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "bot command transaction commit failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "bot_command_failed"}))).into_response();
    }

    let message = json!({
        "id": message_id,
        "content": content,
        "created_at": created_at,
        "username": user.username,
        "author_id": user.id
    });
    let _ = state.realtime.send(json!({
        "type": "message.created",
        "server_id": server_id,
        "channel_id": channel_id,
        "message": message
    }));
    Json(json!({"ok": true, "accepted": true, "queued": true})).into_response()
}

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

    let mut mentioned_ids: Vec<String> = input
        .mentioned_user_ids
        .unwrap_or_default()
        .into_iter()
        .filter(|discord_id| valid_discord_id(discord_id) && discord_id != &input.author_id)
        .take(100)
        .collect();
    mentioned_ids.sort();
    mentioned_ids.dedup();
    let mut notification_recipients = Vec::new();
    if !mentioned_ids.is_empty() {
        let mut target_user_ids = match sqlx::query_scalar::<_, String>(
            "SELECT user_id FROM discord_account_links
             WHERE server_id = $1 AND discord_user_id = ANY($2)
             UNION
             SELECT user_id FROM discord_user_links
             WHERE server_id = $1 AND discord_user_id = ANY($2)",
        )
        .bind(&server_id)
        .bind(&mentioned_ids)
        .fetch_all(&mut *tx)
        .await
        {
            Ok(targets) => targets,
            Err(error) => {
                tracing::error!(%error, "Discord mention target lookup failed");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "discord_message_failed"})),
                )
                    .into_response();
            }
        };
        target_user_ids.retain(|target_user_id| target_user_id != &user_id);
        notification_recipients = target_user_ids.clone();
        if !target_user_ids.is_empty() {
            let notification_ids: Vec<String> = target_user_ids
                .iter()
                .map(|_| Uuid::new_v4().to_string())
                .collect();
            if let Err(error) = sqlx::query(
                "INSERT INTO message_notifications(id, user_id, server_id, channel_id, message_id, kind, created_at)
                 SELECT entries.id, entries.user_id, $3, $4, $5, 'mention', $6
                 FROM unnest($1::text[], $2::text[]) AS entries(id, user_id)
                 ON CONFLICT(user_id, message_id, kind) DO NOTHING",
            )
            .bind(&notification_ids)
            .bind(&target_user_ids)
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
    if !notification_recipients.is_empty() {
        let _ = state.realtime.send(json!({
            "type": "notifications.updated",
            "recipient_ids": notification_recipients
        }));
    }
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
    author_id: Option<String>,
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
        "SELECT o.id, o.discord_channel_id, o.username, o.avatar_url, o.content,
                o.message_id, m.author_id
         FROM discord_outbox o
         LEFT JOIN messages m ON m.id = o.message_id
         WHERE o.processed_at IS NULL
         ORDER BY o.created_at LIMIT 30",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(mut events) => {
            let public_origin = state.public_api_origin.trim_end_matches('/');
            for event in &mut events {
                if event
                    .avatar_url
                    .as_deref()
                    .is_some_and(|avatar| avatar.starts_with("data:image/"))
                {
                    if let Some(author_id) = event.author_id.as_deref() {
                        event.avatar_url = Some(format!(
                            "{public_origin}/api/public/avatars/{author_id}"
                        ));
                    }
                }
            }
            Json(json!({"events": events})).into_response()
        },
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


#[derive(Deserialize, Default)]
struct SyncChannel {
    id: String,
    name: String,
    position: Option<i64>,
    category: Option<String>,
    overwrites: Option<Vec<SyncOverwrite>>,
    locked: Option<bool>,
}

#[derive(Deserialize, Default)]
struct SyncOverwrite {
    id: String,
    target_type: Option<String>,
    allow: Option<Vec<String>>,
    deny: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
struct SyncRole {
    id: String,
    name: String,
    color: Option<String>,
    position: Option<i64>,
}

#[derive(Deserialize, Default)]
struct SyncMember {
    id: String,
    bot: Option<bool>,
    display_name: Option<String>,
    username: Option<String>,
    avatar_url: Option<String>,
    status: Option<String>,
    roles: Option<Vec<String>>,
}

#[derive(Deserialize, Default)]
struct SyncEmoji {
    id: String,
    name: String,
    image_url: String,
}

#[derive(Deserialize)]
struct SyncInput {
    guild_id: String,
    icon_url: Option<String>,
    everyone_role_id: Option<String>,
    channels: Option<Vec<SyncChannel>>,
    roles: Option<Vec<SyncRole>>,
    members: Option<Vec<SyncMember>>,
    emojis: Option<Vec<SyncEmoji>>,
}

async fn sync_snapshot(
    state: &AppState,
    pool: &PgPool,
    system: &(String, String),
    input: SyncInput,
) -> Result<Value, sqlx::Error> {
    let (server_id, owner_id) = system;
    let icon_url = input
        .icon_url
        .as_deref()
        .filter(|value| value.starts_with("https://") && value.len() <= 1000);
    sqlx::query("UPDATE servers SET icon_url = COALESCE($1, icon_url) WHERE id = $2")
        .bind(icon_url)
        .bind(server_id)
        .execute(pool)
        .await?;

    let everyone_role = sqlx::query_scalar::<_, String>(
        "SELECT id FROM roles WHERE server_id = $1 AND name = '@everyone' LIMIT 1",
    )
    .bind(server_id)
    .fetch_optional(pool)
    .await?;
    let member_role = sqlx::query_scalar::<_, String>(
        "SELECT id FROM roles WHERE server_id = $1 AND name = '@Member' LIMIT 1",
    )
    .bind(server_id)
    .fetch_optional(pool)
    .await?;

    let channels: Vec<SyncChannel> = input
        .channels
        .unwrap_or_default()
        .into_iter()
        .take(250)
        .collect();
    let mut channel_lookup = HashMap::<String, String>::new();
    let mut channel_map: Vec<Value> = Vec::new();
    for channel in &channels {
        let discord_channel_id = channel.id.trim();
        let name: String = channel.name.trim().chars().take(80).collect();
        if !valid_discord_id(discord_channel_id) || name.chars().count() < 2 {
            continue;
        }
        let linked = sqlx::query_scalar::<_, String>(
            "SELECT mallow_channel_id FROM discord_channel_links
             WHERE discord_channel_id = $1 AND server_id = $2",
        )
        .bind(discord_channel_id)
        .bind(server_id)
        .fetch_optional(pool)
        .await?;
        let existing = match linked {
            Some(id) => Some(id),
            None => {
                sqlx::query_scalar::<_, String>(
                    "SELECT id FROM channels WHERE server_id = $1 AND name = $2 AND kind = 'text' LIMIT 1",
                )
                .bind(server_id)
                .bind(&name)
                .fetch_optional(pool)
                .await?
            }
        };
        let channel_id = if let Some(id) = existing {
            sqlx::query(
                "UPDATE channels SET name = $1, kind = 'text', position = $2
                 WHERE id = $3 AND server_id = $4",
            )
            .bind(&name)
            .bind(channel.position.unwrap_or_default())
            .bind(&id)
            .bind(server_id)
            .execute(pool)
            .await?;
            id
        } else {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO channels(id, server_id, name, kind, position)
                 VALUES($1, $2, $3, 'text', $4)",
            )
            .bind(&id)
            .bind(server_id)
            .bind(&name)
            .bind(channel.position.unwrap_or_default())
            .execute(pool)
            .await?;
            id
        };
        let category = channel
            .category
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(100).collect::<String>());
        sqlx::query(
            "INSERT INTO discord_channel_links(discord_channel_id, server_id, mallow_channel_id, category_name, updated_at)
             VALUES($1, $2, $3, $4, $5)
             ON CONFLICT(discord_channel_id) DO UPDATE SET
               server_id = EXCLUDED.server_id,
               mallow_channel_id = EXCLUDED.mallow_channel_id,
               category_name = EXCLUDED.category_name,
               updated_at = EXCLUDED.updated_at",
        )
        .bind(discord_channel_id)
        .bind(server_id)
        .bind(&channel_id)
        .bind(category)
        .bind(now())
        .execute(pool)
        .await?;
        channel_lookup.insert(discord_channel_id.to_owned(), channel_id.clone());
        channel_map.push(json!({
            "discord_id": discord_channel_id,
            "mallow_id": channel_id,
            "name": name
        }));
    }

    let roles: Vec<SyncRole> = input
        .roles
        .unwrap_or_default()
        .into_iter()
        .take(250)
        .collect();
    let mut role_lookup = HashMap::<String, String>::new();
    for role in &roles {
        let discord_role_id = role.id.trim();
        let name: String = role
            .name
            .trim()
            .chars()
            .filter(|character| *character != '<' && *character != '>')
            .take(32)
            .collect();
        if !valid_discord_id(discord_role_id) || name.is_empty() || name == "@everyone" {
            continue;
        }
        let color = role
            .color
            .as_deref()
            .filter(|value| {
                value.len() == 7
                    && value.starts_with('#')
                    && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            })
            .unwrap_or("#99aab5");
        let linked = sqlx::query_scalar::<_, String>(
            "SELECT role_id FROM discord_role_links
             WHERE discord_role_id = $1 AND server_id = $2",
        )
        .bind(discord_role_id)
        .bind(server_id)
        .fetch_optional(pool)
        .await?;
        let existing = match linked {
            Some(id) => Some(id),
            None => {
                sqlx::query_scalar::<_, String>(
                    "SELECT id FROM roles WHERE server_id = $1 AND name = $2 LIMIT 1",
                )
                .bind(server_id)
                .bind(&name)
                .fetch_optional(pool)
                .await?
            }
        };
        let role_id = if let Some(id) = existing {
            id
        } else {
            let id = Uuid::new_v4().to_string();
            let inserted = sqlx::query_scalar::<_, String>(
                "INSERT INTO roles(id, server_id, name, is_system, position, color)
                 VALUES($1, $2, $3, 0, $4, $5)
                 ON CONFLICT(server_id, name) DO NOTHING
                 RETURNING id",
            )
            .bind(&id)
            .bind(server_id)
            .bind(&name)
            .bind(role.position.unwrap_or_default())
            .bind(color)
            .fetch_optional(pool)
            .await?;
            match inserted {
                Some(id) => id,
                None => {
                    sqlx::query_scalar::<_, String>(
                        "SELECT id FROM roles WHERE server_id = $1 AND name = $2",
                    )
                    .bind(server_id)
                    .bind(&name)
                    .fetch_one(pool)
                    .await?
                }
            }
        };
        sqlx::query(
            "UPDATE roles SET color = $1, position = $2 WHERE id = $3 AND server_id = $4",
        )
        .bind(color)
        .bind(role.position.unwrap_or_default())
        .bind(&role_id)
        .bind(server_id)
        .execute(pool)
        .await?;
        sqlx::query(
            "INSERT INTO discord_role_links(discord_role_id, server_id, role_id)
             VALUES($1, $2, $3)
             ON CONFLICT(discord_role_id) DO UPDATE SET
               server_id = EXCLUDED.server_id, role_id = EXCLUDED.role_id",
        )
        .bind(discord_role_id)
        .bind(server_id)
        .bind(&role_id)
        .execute(pool)
        .await?;
        role_lookup.insert(discord_role_id.to_owned(), role_id);
    }

    let allowed_permissions = [
        "view_channel",
        "send_messages",
        "read_message_history",
        "attach_files",
        "embed_links",
        "manage_messages",
    ];
    for channel in &channels {
        let discord_channel_id = channel.id.trim();
        let Some(channel_id) = channel_lookup.get(discord_channel_id) else {
            continue;
        };
        for overwrite in channel.overwrites.as_deref().unwrap_or_default() {
            let discord_target = overwrite.id.trim();
            let target_type = if overwrite.target_type.as_deref() == Some("user") {
                "user"
            } else {
                "role"
            };
            let target_id = if target_type == "role" {
                if input
                    .everyone_role_id
                    .as_deref()
                    .is_some_and(|everyone_id| everyone_id == discord_target)
                    || discord_target == input.guild_id
                {
                    everyone_role.clone()
                } else if let Some(id) = role_lookup.get(discord_target) {
                    Some(id.clone())
                } else {
                    sqlx::query_scalar::<_, String>(
                        "SELECT role_id FROM discord_role_links
                         WHERE discord_role_id = $1 AND server_id = $2",
                    )
                    .bind(discord_target)
                    .bind(server_id)
                    .fetch_optional(pool)
                    .await?
                }
            } else {
                linked_user_id(pool, server_id, discord_target).await?
            };
            let Some(target_id) = target_id else {
                continue;
            };
            let allow: Vec<String> = overwrite
                .allow
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|permission| allowed_permissions.contains(&permission.as_str()))
                .cloned()
                .collect();
            let deny: Vec<String> = overwrite
                .deny
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|permission| allowed_permissions.contains(&permission.as_str()))
                .cloned()
                .collect();
            sqlx::query(
                "INSERT INTO channel_permissions(channel_id, target_type, target_id, allow_json, deny_json, updated_at)
                 VALUES($1, $2, $3, $4, $5, $6)
                 ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET
                   allow_json = EXCLUDED.allow_json,
                   deny_json = EXCLUDED.deny_json,
                   updated_at = EXCLUDED.updated_at",
            )
            .bind(channel_id)
            .bind(target_type)
            .bind(target_id)
            .bind(serde_json::to_string(&allow).unwrap_or_else(|_| "[]".to_owned()))
            .bind(serde_json::to_string(&deny).unwrap_or_else(|_| "[]".to_owned()))
            .bind(now())
            .execute(pool)
            .await?;
        }
        let locked = channel.locked.unwrap_or(false)
            || ["rules", "server-rules"].contains(&channel.name.to_ascii_lowercase().as_str());
        if locked {
            if let Some(everyone_id) = everyone_role.as_deref() {
                sqlx::query(
                    "INSERT INTO channel_permissions(channel_id, target_type, target_id, allow_json, deny_json, updated_at)
                     VALUES($1, 'role', $2, '[]', $3, $4)
                     ON CONFLICT(channel_id, target_type, target_id) DO UPDATE SET
                       deny_json = EXCLUDED.deny_json, updated_at = EXCLUDED.updated_at",
                )
                .bind(channel_id)
                .bind(everyone_id)
                .bind("[\"send_messages\"]")
                .bind(now())
                .execute(pool)
                .await?;
            }
        }
    }

    let emojis: Vec<SyncEmoji> = input
        .emojis
        .unwrap_or_default()
        .into_iter()
        .take(250)
        .collect();
    for emoji in &emojis {
        let discord_emoji_id = emoji.id.trim();
        let name: String = emoji
            .name
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
            .take(32)
            .collect();
        if !valid_discord_id(discord_emoji_id)
            || name.chars().count() < 2
            || !emoji.image_url.starts_with("https://")
            || emoji.image_url.len() > 1000
        {
            continue;
        }
        let linked = sqlx::query_scalar::<_, String>(
            "SELECT emoji_id FROM discord_emoji_links
             WHERE discord_emoji_id = $1 AND server_id = $2",
        )
        .bind(discord_emoji_id)
        .bind(server_id)
        .fetch_optional(pool)
        .await?;
        let existing = match linked {
            Some(id) => Some(id),
            None => {
                sqlx::query_scalar::<_, String>(
                    "SELECT id FROM server_emojis WHERE server_id = $1 AND name = $2 LIMIT 1",
                )
                .bind(server_id)
                .bind(&name)
                .fetch_optional(pool)
                .await?
            }
        };
        let emoji_id = existing.unwrap_or_else(|| Uuid::new_v4().to_string());
        sqlx::query(
            "INSERT INTO server_emojis(id, server_id, name, image_url, created_by, created_at)
             VALUES($1, $2, $3, $4, $5, $6)
             ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url",
        )
        .bind(&emoji_id)
        .bind(server_id)
        .bind(&name)
        .bind(&emoji.image_url)
        .bind(owner_id)
        .bind(now())
        .execute(pool)
        .await?;
        sqlx::query(
            "INSERT INTO discord_emoji_links(discord_emoji_id, server_id, emoji_id)
             VALUES($1, $2, $3)
             ON CONFLICT(discord_emoji_id) DO UPDATE SET
               server_id = EXCLUDED.server_id, emoji_id = EXCLUDED.emoji_id",
        )
        .bind(discord_emoji_id)
        .bind(server_id)
        .bind(&emoji_id)
        .execute(pool)
        .await?;
    }

    let members: Vec<SyncMember> = input
        .members
        .unwrap_or_default()
        .into_iter()
        .take(250)
        .collect();
    let mut synced_members = 0usize;
    for member in &members {
        let discord_user_id = member.id.trim();
        if member.bot.unwrap_or(false) || !valid_discord_id(discord_user_id) {
            continue;
        }
        let shadow_user_id = ensure_shadow_user(pool, server_id, discord_user_id).await?;
        let username = member.username.as_deref().unwrap_or("");
        let fallback_name = format!("discord_{discord_user_id}");
        let display_name = member
            .display_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .or(member.username.as_deref())
            .unwrap_or(&fallback_name);
        let display_name: String = display_name.trim().chars().take(32).collect();
        let discord_username: String = username.chars().take(32).collect();
        let avatar_url = member
            .avatar_url
            .as_deref()
            .filter(|value| value.starts_with("https://") && value.len() <= 1000);
        let status = member
            .status
            .as_deref()
            .filter(|value| ["online", "idle", "dnd", "offline"].contains(value))
            .unwrap_or("offline");
        sqlx::query(
            "INSERT INTO user_profiles(user_id, display_name, avatar_url, status, discord_username, updated_at)
             VALUES($1, $2, $3, $4, $5, $6)
             ON CONFLICT(user_id) DO UPDATE SET
               display_name = EXCLUDED.display_name,
               avatar_url = EXCLUDED.avatar_url,
               status = EXCLUDED.status,
               discord_username = EXCLUDED.discord_username,
               updated_at = EXCLUDED.updated_at",
        )
        .bind(&shadow_user_id)
        .bind(&display_name)
        .bind(avatar_url)
        .bind(status)
        .bind(&discord_username)
        .bind(now())
        .execute(pool)
        .await?;

        let member_user_id = linked_user_id(pool, server_id, discord_user_id)
            .await?
            .unwrap_or(shadow_user_id);
        sqlx::query(
            "INSERT INTO memberships(server_id, user_id, joined_at)
             VALUES($1, $2, $3) ON CONFLICT(server_id, user_id) DO NOTHING",
        )
        .bind(server_id)
        .bind(&member_user_id)
        .bind(now())
        .execute(pool)
        .await?;
        for default_role in [everyone_role.as_ref(), member_role.as_ref()]
            .into_iter()
            .flatten()
        {
            sqlx::query(
                "INSERT INTO member_roles(server_id, user_id, role_id)
                 VALUES($1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(server_id)
            .bind(&member_user_id)
            .bind(default_role)
            .execute(pool)
            .await?;
        }
        if let Some(discord_roles) = member.roles.as_deref() {
            // Replace only Discord-managed role assignments. Native MallowCord
            // roles are intentionally preserved for linked accounts.
            sqlx::query(
                "DELETE FROM member_roles AS assigned
                 USING discord_role_links AS linked
                 WHERE assigned.server_id = $1
                   AND assigned.user_id = $2
                   AND assigned.role_id = linked.role_id
                   AND linked.server_id = $1
                   AND NOT (linked.discord_role_id = ANY($3::text[]))",
            )
            .bind(server_id)
            .bind(&member_user_id)
            .bind(discord_roles)
            .execute(pool)
            .await?;
        }
        for discord_role_id in member.roles.as_deref().unwrap_or_default() {
            let role_id = if let Some(id) = role_lookup.get(discord_role_id) {
                Some(id.clone())
            } else {
                sqlx::query_scalar::<_, String>(
                    "SELECT role_id FROM discord_role_links
                     WHERE discord_role_id = $1 AND server_id = $2",
                )
                .bind(discord_role_id)
                .bind(server_id)
                .fetch_optional(pool)
                .await?
            };
            if let Some(role_id) = role_id {
                sqlx::query(
                    "INSERT INTO member_roles(server_id, user_id, role_id)
                     VALUES($1, $2, $3) ON CONFLICT DO NOTHING",
                )
                .bind(server_id)
                .bind(&member_user_id)
                .bind(role_id)
                .execute(pool)
                .await?;
            }
        }
        synced_members += 1;
    }

    let _ = state.realtime.send(json!({
        "type": "server.sync.updated",
        "server_id": server_id
    }));
    Ok(json!({
        "ok": true,
        "server_id": server_id,
        "channels": channel_map.len(),
        "roles": role_lookup.len(),
        "members": synced_members,
        "channel_map": channel_map
    }))
}

async fn sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<SyncInput>,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    if !guild_matches(&state, &input.guild_id) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "This bridge is restricted to the configured official Discord server."})),
        )
            .into_response();
    }
    let system = match system_server(&pool).await {
        Ok(Some(system)) => system,
        Ok(None) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "Mallow Swamp could not be initialized."})),
            )
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "Discord snapshot server lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_sync_failed"})),
            )
                .into_response();
        }
    };
    match sync_snapshot(&state, &pool, &system, input).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => {
            tracing::error!(%error, "Discord snapshot sync failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "discord_sync_failed"})),
            )
                .into_response()
        }
    }
}


#[derive(Serialize, FromRow)]
struct BotUser {
    id: String,
    username: String,
    account_type: String,
    status: String,
    timeout_until: Option<i64>,
    created_at: i64,
}

async fn list_bot_users(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    match sqlx::query_as::<_, BotUser>(
        "SELECT id, username, account_type, status, timeout_until, created_at
         FROM users ORDER BY created_at DESC LIMIT 500",
    )
    .fetch_all(&pool)
    .await
    {
        Ok(users) => Json(json!({"users": users})).into_response(),
        Err(error) => {
            tracing::error!(%error, "Mallow-Bot user list lookup failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "bot_user_lookup_failed"})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize, Serialize)]
struct BotModerationInput {
    seconds: Option<i64>,
    reason: Option<String>,
}

async fn moderate_bot_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((target_id, action)): Path<(String, String)>,
    Json(input): Json<BotModerationInput>,
) -> Response {
    let pool = match require_bot(&state, &headers) {
        Ok(pool) => pool,
        Err(response) => return *response,
    };
    if target_id.is_empty() || target_id.len() > 128 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid user ID."})))
            .into_response();
    }
    if !["timeout", "ban", "unban", "delete"].contains(&action.as_str()) {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "Unknown moderation action."})))
            .into_response();
    }
    let owner_id = match sqlx::query_scalar::<_, String>(
        "SELECT id FROM users WHERE account_type = 'owner' LIMIT 1",
    )
    .fetch_optional(&pool)
    .await
    {
        Ok(Some(id)) => id,
        Ok(None) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error": "Owner not initialized."})),
            )
                .into_response()
        }
        Err(error) => {
            tracing::error!(%error, "Mallow-Bot moderation owner lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "bot_moderation_failed"})),
            )
                .into_response();
        }
    };

    let timestamp = now();
    let result = match action.as_str() {
        "timeout" => {
            let seconds = input.seconds.unwrap_or(600).clamp(60, 2_592_000);
            sqlx::query(
                "UPDATE users SET status = 'timed_out', timeout_until = $1, updated_at = $2
                 WHERE id = $3",
            )
            .bind(timestamp + seconds)
            .bind(timestamp)
            .bind(&target_id)
            .execute(&pool)
            .await
        }
        "ban" => {
            let update = sqlx::query(
                "UPDATE users SET status = 'banned', updated_at = $1 WHERE id = $2",
            )
            .bind(timestamp)
            .bind(&target_id)
            .execute(&pool)
            .await;
            if update.is_ok() {
                sqlx::query("DELETE FROM sessions WHERE user_id = $1")
                    .bind(&target_id)
                    .execute(&pool)
                    .await
            } else {
                update
            }
        }
        "unban" => {
            sqlx::query(
                "UPDATE users SET status = 'active', timeout_until = NULL, updated_at = $1
                 WHERE id = $2",
            )
            .bind(timestamp)
            .bind(&target_id)
            .execute(&pool)
            .await
        }
        "delete" => {
            let sessions = sqlx::query("DELETE FROM sessions WHERE user_id = $1")
                .bind(&target_id)
                .execute(&pool)
                .await;
            if sessions.is_ok() {
                sqlx::query("DELETE FROM users WHERE id = $1")
                    .bind(&target_id)
                    .execute(&pool)
                    .await
            } else {
                sessions
            }
        }
        _ => unreachable!(),
    };
    if let Err(error) = result {
        tracing::error!(%error, action, "Mallow-Bot moderation update failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "bot_moderation_failed"})),
        )
            .into_response();
    }

    let details = serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_owned());
    if let Err(error) = sqlx::query(
        "INSERT INTO audit_logs(id, actor_id, target_user_id, action, details, created_at)
         VALUES($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&owner_id)
    .bind(&target_id)
    .bind(format!("mallowbot_{action}"))
    .bind(details)
    .bind(timestamp)
    .execute(&pool)
    .await
    {
        tracing::error!(%error, action, "Mallow-Bot moderation audit insert failed");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": "bot_moderation_audit_failed"})),
        )
            .into_response();
    }
    Json(json!({"ok": true})).into_response()
}

async fn deprecated_bot_user_create(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_bot(&state, &headers) {
        return *response;
    }
    (
        StatusCode::GONE,
        Json(json!({"error": "MallowCord accounts must be created through Google or Discord OAuth."})),
    )
        .into_response()
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}



/// Dispatch a durable, authenticated Mallow-Bot event through the same validated
/// handlers used by the compatibility HTTP endpoints.
pub(crate) async fn process_inbox_event(
    state: AppState,
    event_type: &str,
    payload: Value,
) -> Result<(), String> {
    let secret = state
        .mallowbot_service_key
        .as_ref()
        .ok_or_else(|| "Mallow-Bot service key is not configured".to_owned())?;
    let mut headers = HeaderMap::new();
    let value = axum::http::HeaderValue::from_bytes(secret.as_slice())
        .map_err(|_| "Mallow-Bot service key is not a valid HTTP header".to_owned())?;
    headers.insert("x-mallowbot-key", value);

    let response = match event_type {
        "discord.member.joined" | "discord.member.updated" => {
            let input: SyncInput = serde_json::from_value(payload)
                .map_err(|error| format!("Invalid member event payload: {error}"))?;
            sync(State(state), headers, Json(input)).await
        }
        "discord.presence.updated" => {
            let input: PresenceInput = serde_json::from_value(payload)
                .map_err(|error| format!("Invalid presence event payload: {error}"))?;
            presence(State(state), headers, Json(input)).await
        }
        "discord.message.created" => {
            let input: DiscordMessageInput = serde_json::from_value(payload)
                .map_err(|error| format!("Invalid message event payload: {error}"))?;
            discord_message(State(state), headers, Json(input)).await
        }
        other => return Err(format!("Unsupported Mallow-Bot event type: {other}")),
    };

    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("Event handler returned HTTP {status}"))
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/discord/link/status", get(discord_link_status))
        .route("/api/discord/link/start", post(discord_link_start))
        .route("/api/bot/command", post(bot_command))
        .route("/api/integrations/mallowbot/discord/sync", post(sync))
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
        .route("/api/integrations/mallowbot/users", get(list_bot_users).post(deprecated_bot_user_create))
        .route(
            "/api/integrations/mallowbot/users/{target_id}/{action}",
            post(moderate_bot_user),
        )
}
