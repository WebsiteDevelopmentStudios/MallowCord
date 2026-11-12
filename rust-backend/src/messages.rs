use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use crate::{
    auth::{current_user, AuthUser},
    server::channel_permission_allowed,
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
            tracing::error!(%error, "message API session lookup failed");
            Err(Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            )
                .into_response()))
        }
    }
}

async fn channel_access(
    pool: &PgPool,
    user: &AuthUser,
    channel_id: &str,
    permission: &str,
) -> Result<String, Box<Response>> {
    let server_id = sqlx::query_scalar::<_, String>(
        "SELECT server_id FROM channels WHERE id = $1",
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        tracing::error!(%error, "channel lookup failed");
        Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_lookup_failed"}))).into_response())
    })?
    .ok_or_else(|| Box::new((StatusCode::NOT_FOUND, Json(json!({"error": "Channel not found."}))).into_response()))?;

    match channel_permission_allowed(pool, &user.id, channel_id, permission).await {
        Ok(true) => Ok(server_id),
        Ok(false) => Err(Box::new((StatusCode::FORBIDDEN, Json(json!({"error": "You cannot access this channel."}))).into_response())),
        Err(error) => {
            tracing::error!(%error, "channel permission lookup failed");
            Err(Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_permissions_failed"}))).into_response()))
        }
    }
}

#[derive(FromRow)]
struct MessageRow {
    id: String,
    content: String,
    created_at: i64,
    edited_at: Option<i64>,
    username: String,
    avatar_url: Option<String>,
    bio: Option<String>,
    status: Option<String>,
    pronouns: Option<String>,
    author_id: String,
    role_color: String,
    reply_to_id: Option<String>,
    reply_username: Option<String>,
    reply_content: Option<String>,
    is_mentioned: bool,
    is_reply_to_you: bool,
    forwarded_from: Option<String>,
}

#[derive(FromRow)]
struct BotMessageRow {
    id: String,
    content: String,
    created_at: i64,
    username: String,
    avatar_url: Option<String>,
    source_user_id: Option<String>,
}

#[derive(FromRow)]
struct AttachmentRow {
    id: String,
    message_id: String,
    filename: String,
    content_type: String,
    size: i64,
}

#[derive(FromRow)]
struct ReactionRow {
    message_id: String,
    emoji: String,
    count: i64,
    mine: bool,
    custom_name: Option<String>,
    custom_url: Option<String>,
}

async fn list_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let server_id = match channel_access(&pool, &user, &channel_id, "view_channel").await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(response) = channel_access(&pool, &user, &channel_id, "read_message_history").await {
        return *response;
    }

    let regular = sqlx::query_as::<_, MessageRow>(
        "SELECT m.id, m.content, m.created_at, m.edited_at,
                COALESCE(up.display_name, u.username) AS username,
                up.avatar_url, up.bio, up.status, up.pronouns, u.id AS author_id,
                COALESCE((
                    SELECT r.color FROM member_roles mr
                    JOIN roles r ON r.id = mr.role_id
                    WHERE mr.server_id = $1 AND mr.user_id = u.id
                    ORDER BY r.position DESC LIMIT 1
                ), '') AS role_color,
                pr.reply_to_id, ru.username AS reply_username, rm.content AS reply_content,
                EXISTS(
                    SELECT 1 FROM message_notifications mn
                    WHERE mn.message_id = m.id AND mn.user_id = $2
                      AND mn.kind = 'mention' AND mn.seen_at IS NULL
                ) AS is_mentioned,
                EXISTS(
                    SELECT 1 FROM message_notifications mn
                    WHERE mn.message_id = m.id AND mn.user_id = $2
                      AND mn.kind = 'reply' AND mn.seen_at IS NULL
                ) AS is_reply_to_you,
                (SELECT mf.source_username FROM message_forwards mf WHERE mf.message_id = m.id) AS forwarded_from
         FROM messages m
         JOIN users u ON u.id = m.author_id
         LEFT JOIN user_profiles up ON up.user_id = u.id
         LEFT JOIN message_replies pr ON pr.message_id = m.id
         LEFT JOIN messages rm ON rm.id = pr.reply_to_id
         LEFT JOIN users ru ON ru.id = rm.author_id
         WHERE m.channel_id = $3
         ORDER BY m.created_at DESC
         LIMIT 75",
    )
    .bind(&server_id)
    .bind(&user.id)
    .bind(&channel_id)
    .fetch_all(&pool)
    .await;
    let mut regular = match regular {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "failed to load channel messages");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "messages_lookup_failed"}))).into_response();
        }
    };
    regular.reverse();

    let message_ids: Vec<String> = regular.iter().map(|message| message.id.clone()).collect();
    let attachments = if message_ids.is_empty() {
        Ok(Vec::new())
    } else {
        sqlx::query_as::<_, AttachmentRow>(
            "SELECT id, message_id, filename, content_type, size
             FROM message_attachments WHERE message_id = ANY($1)
             ORDER BY created_at",
        )
        .bind(&message_ids)
        .fetch_all(&pool)
        .await
    };
    let attachments = match attachments {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "failed to load message attachments");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "attachments_lookup_failed"}))).into_response();
        }
    };
    let mut attachments_by_message: HashMap<String, Vec<Value>> = HashMap::new();
    for file in attachments {
        attachments_by_message
            .entry(file.message_id)
            .or_default()
            .push(json!({
                "id": file.id,
                "filename": file.filename,
                "content_type": file.content_type,
                "size": file.size
            }));
    }

    let reactions = if message_ids.is_empty() {
        Ok(Vec::new())
    } else {
        sqlx::query_as::<_, ReactionRow>(
            "SELECT r.message_id, r.emoji, COUNT(*)::bigint AS count,
                    BOOL_OR(r.user_id = $1) AS mine,
                    se.name AS custom_name, se.image_url AS custom_url
             FROM message_reactions r
             LEFT JOIN server_emojis se ON r.emoji = 'custom:' || se.id
             WHERE r.message_id = ANY($2)
             GROUP BY r.message_id, r.emoji, se.name, se.image_url",
        )
        .bind(&user.id)
        .bind(&message_ids)
        .fetch_all(&pool)
        .await
    };
    let reactions = match reactions {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "failed to load message reactions");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "reactions_lookup_failed"}))).into_response();
        }
    };
    let mut reactions_by_message: HashMap<String, Vec<Value>> = HashMap::new();
    for reaction in reactions {
        reactions_by_message
            .entry(reaction.message_id)
            .or_default()
            .push(json!({
                "emoji": reaction.emoji,
                "count": reaction.count,
                "mine": reaction.mine,
                "custom_name": reaction.custom_name,
                "custom_url": reaction.custom_url
            }));
    }

    let bots = sqlx::query_as::<_, BotMessageRow>(
        "SELECT id, content, created_at, username, avatar_url, source_user_id
         FROM bot_messages WHERE channel_id = $1
         ORDER BY created_at DESC LIMIT 75",
    )
    .bind(&channel_id)
    .fetch_all(&pool)
    .await;
    let bots = match bots {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "failed to load bot messages");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "messages_lookup_failed"}))).into_response();
        }
    };

    let mut combined: Vec<(i64, Value)> = Vec::new();
    for message in regular {
        let reply_to = match (message.reply_to_id, message.reply_username, message.reply_content) {
            (Some(_), Some(username), Some(content)) => json!({"username": username, "content": content}),
            _ => Value::Null,
        };
        let attachments = attachments_by_message.remove(&message.id).unwrap_or_default();
        let reactions = reactions_by_message.remove(&message.id).unwrap_or_default();
        combined.push((
            message.created_at,
            json!({
                "id": message.id,
                "content": message.content,
                "created_at": message.created_at,
                "edited_at": message.edited_at,
                "username": message.username,
                "avatar_url": message.avatar_url,
                "bio": message.bio,
                "status": message.status,
                "pronouns": message.pronouns,
                "author_id": message.author_id,
                "role_color": message.role_color,
                "is_mentioned": message.is_mentioned,
                "is_reply_to_you": message.is_reply_to_you,
                "forwarded_from": message.forwarded_from,
                "is_bot": false,
                "reply_to": reply_to,
                "reactions": reactions,
                "attachments": attachments
            }),
        ));
    }
    for bot in bots {
        combined.push((
            bot.created_at,
            json!({
                "id": bot.id,
                "content": bot.content,
                "created_at": bot.created_at,
                "edited_at": null,
                "username": bot.username,
                "avatar_url": bot.avatar_url,
                "author_id": "mallowcord-bot",
                "source_user_id": bot.source_user_id,
                "is_bot": true,
                "forwarded_from": null,
                "reply_to": null,
                "reactions": [],
                "attachments": []
            }),
        ));
    }
    combined.sort_by_key(|item| item.0);
    let start = combined.len().saturating_sub(75);
    let messages: Vec<Value> = combined.into_iter().skip(start).map(|(_, message)| message).collect();

    let mut result = json!({"messages": messages});
    if query.get("include_directory").map(String::as_str) == Some("1") {
        let roles = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT id, name, pingable FROM roles WHERE server_id = $1",
        )
        .bind(&server_id)
        .fetch_all(&pool)
        .await;
        let users = sqlx::query_as::<_, (String, String, String)>(
            "SELECT u.id, u.username, COALESCE(up.display_name, u.username) AS display_name
             FROM memberships m JOIN users u ON u.id = m.user_id
             LEFT JOIN user_profiles up ON up.user_id = u.id
             WHERE m.server_id = $1",
        )
        .bind(&server_id)
        .fetch_all(&pool)
        .await;
        let channels = sqlx::query_as::<_, (String, String, String)>(
            "SELECT id, name, kind FROM channels WHERE server_id = $1 AND kind = 'text' ORDER BY position",
        )
        .bind(&server_id)
        .fetch_all(&pool)
        .await;
        match (roles, users, channels) {
            (Ok(roles), Ok(users), Ok(channels)) => {
                result["role_mentions"] = json!(roles.into_iter().map(|(id, name, pingable)| json!({"id":id,"name":name,"pingable":pingable})).collect::<Vec<_>>());
                result["user_mentions"] = json!(users.into_iter().map(|(id, username, display_name)| json!({"id":id,"username":username,"display_name":display_name})).collect::<Vec<_>>());
                result["channel_mentions"] = json!(channels.into_iter().map(|(id, name, kind)| json!({"id":id,"name":name,"kind":kind})).collect::<Vec<_>>());
            }
            (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
                tracing::error!(%error, "failed to load mention directory");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "mention_directory_failed"}))).into_response();
            }
        }
    }
    Json(result).into_response()
}

#[derive(Deserialize)]
struct SendMessageInput {
    content: Option<String>,
    attachment_ids: Option<Vec<String>>,
    reply_to_id: Option<String>,
}

async fn send_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    Json(input): Json<SendMessageInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let server_id = match channel_access(&pool, &user, &channel_id, "view_channel").await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if let Err(response) = channel_access(&pool, &user, &channel_id, "send_messages").await {
        return *response;
    }

    let content = input.content.unwrap_or_default().trim().to_owned();
    let content_length = content.chars().count();
    let mut attachment_ids: Vec<String> = input
        .attachment_ids
        .unwrap_or_default()
        .into_iter()
        .filter(|value| value.len() <= 80 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)))
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    attachment_ids.sort();
    if (content.is_empty() && attachment_ids.is_empty()) || content_length > 4000 || attachment_ids.len() > 10 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Add a message or up to 10 attachments."}))).into_response();
    }

    for attachment_id in &attachment_ids {
        let pending = sqlx::query_scalar::<_, String>(
            "SELECT id FROM message_attachments
             WHERE id = $1 AND channel_id = $2 AND uploader_id = $3 AND message_id IS NULL",
        )
        .bind(attachment_id)
        .bind(&channel_id)
        .bind(&user.id)
        .fetch_optional(&pool)
        .await;
        match pending {
            Ok(Some(_)) => {}
            Ok(None) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "One of the uploaded files is unavailable. Please attach it again."}))).into_response(),
            Err(error) => {
                tracing::error!(%error, "pending attachment validation failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "attachment_validation_failed"}))).into_response();
            }
        }
    }

    let roles = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT id, name, pingable FROM roles WHERE server_id = $1",
    )
    .bind(&server_id)
    .fetch_all(&pool)
    .await;
    let roles = match roles {
        Ok(roles) => roles,
        Err(error) => {
            tracing::error!(%error, "role mention lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
        }
    };
    let users = sqlx::query_as::<_, (String, String)>(
        "SELECT u.id, u.username FROM memberships m
         JOIN users u ON u.id = m.user_id WHERE m.server_id = $1",
    )
    .bind(&server_id)
    .fetch_all(&pool)
    .await;
    let users = match users {
        Ok(users) => users,
        Err(error) => {
            tracing::error!(%error, "user mention lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
        }
    };
    let lower_content = content.to_lowercase();
    let mut notifications: HashSet<String> = HashSet::new();
    for (target_id, username) in &users {
        if target_id != &user.id && lower_content.contains(&format!("@{}", username.to_lowercase())) {
            notifications.insert(target_id.clone());
        }
    }
    for (role_id, role_name, pingable) in &roles {
        let token = if role_name.starts_with('@') {
            role_name.to_lowercase()
        } else {
            format!("@{}", role_name.to_lowercase())
        };
        if !lower_content.contains(&token) {
            continue;
        }
        if *pingable == 0 {
            return (StatusCode::FORBIDDEN, Json(json!({"error": format!("The {} role does not allow mentions.", role_name)}))).into_response();
        }
        let recipients = if role_name.eq_ignore_ascii_case("@everyone") {
            users.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>()
        } else {
            sqlx::query_scalar::<_, String>(
                "SELECT user_id FROM member_roles WHERE server_id = $1 AND role_id = $2",
            )
            .bind(&server_id)
            .bind(role_id)
            .fetch_all(&pool)
            .await
            .unwrap_or_default()
        };
        for target in recipients {
            if target != user.id {
                notifications.insert(target);
            }
        }
    }

    let message_id = Uuid::new_v4().to_string();
    let created_at = now();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "message transaction could not start");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO messages(id, channel_id, author_id, content, created_at)
         VALUES($1, $2, $3, $4, $5)",
    )
    .bind(&message_id)
    .bind(&channel_id)
    .bind(&user.id)
    .bind(&content)
    .bind(created_at)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted {
        tracing::error!(%error, "message insert failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
    }

    for attachment_id in &attachment_ids {
        let updated = sqlx::query(
            "UPDATE message_attachments SET message_id = $1
             WHERE id = $2 AND channel_id = $3 AND uploader_id = $4 AND message_id IS NULL",
        )
        .bind(&message_id)
        .bind(attachment_id)
        .bind(&channel_id)
        .bind(&user.id)
        .execute(&mut *tx)
        .await;
        match updated {
            Ok(result) if result.rows_affected() == 1 => {}
            Ok(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "One of the uploaded files is unavailable. Please attach it again."}))).into_response(),
            Err(error) => {
                tracing::error!(%error, "attachment link update failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
            }
        }
    }

    let mut reply_recipient = None;
    if let Some(reply_id) = input.reply_to_id {
        let parent = sqlx::query_as::<_, (String, String)>(
            "SELECT id, author_id FROM messages WHERE id = $1 AND channel_id = $2",
        )
        .bind(reply_id)
        .bind(&channel_id)
        .fetch_optional(&mut *tx)
        .await;
        match parent {
            Ok(Some((parent_id, author_id))) => {
                let inserted = sqlx::query(
                    "INSERT INTO message_replies(message_id, reply_to_id) VALUES($1, $2)",
                )
                .bind(&message_id)
                .bind(parent_id)
                .execute(&mut *tx)
                .await;
                if let Err(error) = inserted {
                    tracing::error!(%error, "message reply link insert failed");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
                }
                if author_id != user.id {
                    notifications.insert(author_id.clone());
                    reply_recipient = Some(author_id);
                }
            }
            Ok(None) => {}
            Err(error) => {
                tracing::error!(%error, "reply target lookup failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
            }
        }
    }

    let discord_channel = sqlx::query_scalar::<_, String>(
        "SELECT discord_channel_id FROM discord_channel_links WHERE mallow_channel_id = $1",
    )
    .bind(&channel_id)
    .fetch_optional(&mut *tx)
    .await;
    match discord_channel {
        Ok(Some(discord_channel_id)) => {
            let author = sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT COALESCE(up.display_name, u.username), up.avatar_url
                 FROM users u LEFT JOIN user_profiles up ON up.user_id = u.id
                 WHERE u.id = $1",
            )
            .bind(&user.id)
            .fetch_one(&mut *tx)
            .await;
            match author {
                Ok((username, avatar_url)) => {
                    let queued = sqlx::query(
                        "INSERT INTO discord_outbox(id, discord_channel_id, message_id, username, avatar_url, content, created_at)
                         VALUES($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(message_id) DO NOTHING",
                    )
                    .bind(Uuid::new_v4().to_string())
                    .bind(discord_channel_id)
                    .bind(&message_id)
                    .bind(username)
                    .bind(avatar_url)
                    .bind(&content)
                    .bind(created_at)
                    .execute(&mut *tx)
                    .await;
                    if let Err(error) = queued {
                        tracing::error!(%error, "Discord bridge outbox insert failed");
                        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
                    }
                }
                Err(error) => {
                    tracing::error!(%error, "message author profile lookup failed");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
                }
            }
        }
        Ok(None) => {}
        Err(error) => {
            tracing::error!(%error, "Discord channel link lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
        }
    }

    for target_id in notifications {
        let kind = if reply_recipient.as_deref() == Some(target_id.as_str()) {
            "reply"
        } else {
            "mention"
        };
        let inserted = sqlx::query(
            "INSERT INTO message_notifications(id, user_id, server_id, channel_id, message_id, kind, created_at)
             VALUES($1, $2, $3, $4, $5, $6, $7) ON CONFLICT(user_id, message_id, kind) DO NOTHING",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(target_id)
        .bind(&server_id)
        .bind(&channel_id)
        .bind(&message_id)
        .bind(kind)
        .bind(created_at)
        .execute(&mut *tx)
        .await;
        if let Err(error) = inserted {
            tracing::error!(%error, "message notification insert failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
        }
    }

    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "message transaction commit failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_send_failed"}))).into_response();
    }

    (
        StatusCode::CREATED,
        Json(json!({
            "message": {
                "id": message_id,
                "content": content,
                "created_at": created_at,
                "username": user.username,
                "author_id": user.id
            }
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
struct EditMessageInput {
    content: String,
}

async fn message_metadata(
    pool: &PgPool,
    message_id: &str,
) -> Result<Option<(String, String, String)>, sqlx::Error> {
    sqlx::query_as::<_, (String, String, String)>(
        "SELECT m.author_id, m.channel_id, c.server_id
         FROM messages m JOIN channels c ON c.id = m.channel_id
         WHERE m.id = $1",
    )
    .bind(message_id)
    .fetch_optional(pool)
    .await
}

async fn edit_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
    Json(input): Json<EditMessageInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let metadata = match message_metadata(&pool, &message_id).await {
        Ok(Some(value)) => value,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Message not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "message lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_lookup_failed"}))).into_response();
        }
    };
    if metadata.0 != user.id {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "You can only edit your own messages."}))).into_response();
    }
    let content = input.content.trim();
    let length = content.chars().count();
    if length == 0 || length > 4000 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Message must be 1–4000 characters."}))).into_response();
    }
    match sqlx::query("UPDATE messages SET content = $1, edited_at = $2 WHERE id = $3")
        .bind(content)
        .bind(now())
        .bind(&message_id)
        .execute(&pool)
        .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "message edit failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_edit_failed"}))).into_response()
        }
    }
}

async fn delete_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let metadata = match message_metadata(&pool, &message_id).await {
        Ok(Some(value)) => value,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Message not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "message lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_lookup_failed"}))).into_response();
        }
    };
    if metadata.0 != user.id && user.account_type != "owner" {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "You can only delete your own messages."}))).into_response();
    }
    match sqlx::query("DELETE FROM messages WHERE id = $1")
        .bind(&message_id)
        .execute(&pool)
        .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "message delete failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_delete_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct ReactionInput {
    emoji: String,
}

async fn toggle_reaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
    Json(input): Json<ReactionInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let metadata = match message_metadata(&pool, &message_id).await {
        Ok(Some(value)) => value,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Message not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "message lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_lookup_failed"}))).into_response();
        }
    };
    let member = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&metadata.2)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    match member {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::FORBIDDEN, Json(json!({"error": "You cannot access this message."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "message membership lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_lookup_failed"}))).into_response();
        }
    }

    let emoji = input.emoji;
    if let Some(custom_id) = emoji.strip_prefix("custom:") {
        let exists = sqlx::query_scalar::<_, String>(
            "SELECT id FROM server_emojis WHERE id = $1 AND server_id = $2",
        )
        .bind(custom_id)
        .bind(&metadata.2)
        .fetch_optional(&pool)
        .await;
        match exists {
            Ok(Some(_)) => {}
            Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Custom emoji not found in this server."}))).into_response(),
            Err(error) => {
                tracing::error!(%error, "custom emoji lookup failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "reaction_update_failed"}))).into_response();
            }
        }
    } else if !["👍", "❤️", "😂", "🎉", "👀", "🔥", "😭", "💀", "😮", "😢", "👏", "✅", "😀", "🥹", "😍", "😎", "🙏", "✨", "🚀", "💯", "👎", "🤔"].contains(&emoji.as_str()) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "That reaction is not supported."}))).into_response();
    }

    let existing = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3",
    )
    .bind(&message_id)
    .bind(&user.id)
    .bind(&emoji)
    .fetch_optional(&pool)
    .await;
    let added = match existing {
        Ok(Some(_)) => {
            match sqlx::query("DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3")
                .bind(&message_id)
                .bind(&user.id)
                .bind(&emoji)
                .execute(&pool)
                .await
            {
                Ok(_) => false,
                Err(error) => {
                    tracing::error!(%error, "reaction removal failed");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "reaction_update_failed"}))).into_response();
                }
            }
        }
        Ok(None) => {
            match sqlx::query("INSERT INTO message_reactions(message_id, user_id, emoji, created_at) VALUES($1, $2, $3, $4)")
                .bind(&message_id)
                .bind(&user.id)
                .bind(&emoji)
                .bind(now())
                .execute(&pool)
                .await
            {
                Ok(_) => true,
                Err(error) => {
                    tracing::error!(%error, "reaction insert failed");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "reaction_update_failed"}))).into_response();
                }
            }
        }
        Err(error) => {
            tracing::error!(%error, "reaction lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "reaction_update_failed"}))).into_response();
        }
    };
    Json(json!({"ok": true, "added": added})).into_response()
}

#[derive(Deserialize)]
struct ForwardInput {
    target_channel_id: String,
}

async fn forward_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
    Json(input): Json<ForwardInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let source = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT m.id, m.content, u.username, c.server_id
         FROM messages m
         JOIN users u ON u.id = m.author_id
         JOIN channels c ON c.id = m.channel_id
         WHERE m.id = $1",
    )
    .bind(&message_id)
    .fetch_optional(&pool)
    .await;
    let (source_id, source_content, source_username, source_server) = match source {
        Ok(Some(source)) => source,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Message not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "forward source lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_forward_failed"}))).into_response();
        }
    };
    let source_member = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&source_server)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    if !matches!(source_member, Ok(Some(_))) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "You cannot access this message."}))).into_response();
    }
    let target = sqlx::query_as::<_, (String, String)>(
        "SELECT c.id, c.server_id FROM channels c
         JOIN memberships m ON m.server_id = c.server_id
         WHERE c.id = $1 AND m.user_id = $2 AND c.kind = 'text'",
    )
    .bind(&input.target_channel_id)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    if !matches!(target, Ok(Some(_))) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Choose a text channel you belong to."}))).into_response();
    }
    let id = Uuid::new_v4().to_string();
    let created_at = now();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "forward transaction failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_forward_failed"}))).into_response();
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO messages(id, channel_id, author_id, content, created_at)
         VALUES($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(&input.target_channel_id)
    .bind(&user.id)
    .bind(&source_content)
    .bind(created_at)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted {
        tracing::error!(%error, "forward message insert failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_forward_failed"}))).into_response();
    }
    let forward = sqlx::query(
        "INSERT INTO message_forwards(message_id, source_message_id, source_username, created_at)
         VALUES($1, $2, $3, $4)",
    )
    .bind(&id)
    .bind(source_id)
    .bind(&source_username)
    .bind(created_at)
    .execute(&mut *tx)
    .await;
    if let Err(error) = forward {
        tracing::error!(%error, "forward metadata insert failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_forward_failed"}))).into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "forward transaction commit failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "message_forward_failed"}))).into_response();
    }
    (StatusCode::CREATED, Json(json!({"ok": true, "message": {"id": id, "content": source_content, "created_at": created_at}}))).into_response()
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/channels/{channel_id}/messages", get(list_messages).post(send_message))
        .route("/api/messages/{message_id}/edit", post(edit_message))
        .route("/api/messages/{message_id}/reactions", post(toggle_reaction))
        .route("/api/messages/{message_id}/forward", post(forward_message))
        .route("/api/messages/{message_id}", delete(delete_message))
}
