use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

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
            tracing::error!(%error, "failed to authenticate social API request");
            Err(Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            )
                .into_response()))
        }
    }
}

#[derive(Serialize, FromRow)]
struct FriendView {
    id: String,
    username: String,
    display_name: String,
    avatar_url: Option<String>,
    status: Option<String>,
}

#[derive(Serialize, FromRow)]
struct FriendRequestView {
    id: String,
    user_id: String,
    username: String,
    display_name: String,
    avatar_url: Option<String>,
    created_at: i64,
}

async fn list_friends(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };

    let friends = sqlx::query_as::<_, FriendView>(
        "SELECT u.id, u.username, COALESCE(up.display_name, u.username) AS display_name,
                up.avatar_url, up.status
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_low_id = $1 THEN f.user_high_id ELSE f.user_low_id END
         LEFT JOIN user_profiles up ON up.user_id = u.id
         WHERE f.user_low_id = $1 OR f.user_high_id = $1
         ORDER BY COALESCE(up.display_name, u.username)",
    )
    .bind(&user.id)
    .fetch_all(&pool)
    .await;

    let incoming = sqlx::query_as::<_, FriendRequestView>(
        "SELECT fr.id, fr.sender_id AS user_id, u.username,
                COALESCE(up.display_name, u.username) AS display_name,
                up.avatar_url, fr.created_at
         FROM friend_requests fr
         JOIN users u ON u.id = fr.sender_id
         LEFT JOIN user_profiles up ON up.user_id = u.id
         WHERE fr.recipient_id = $1 AND fr.status = 'pending'
         ORDER BY fr.created_at DESC",
    )
    .bind(&user.id)
    .fetch_all(&pool)
    .await;

    let outgoing = sqlx::query_as::<_, FriendRequestView>(
        "SELECT fr.id, fr.recipient_id AS user_id, u.username,
                COALESCE(up.display_name, u.username) AS display_name,
                up.avatar_url, fr.created_at
         FROM friend_requests fr
         JOIN users u ON u.id = fr.recipient_id
         LEFT JOIN user_profiles up ON up.user_id = u.id
         WHERE fr.sender_id = $1 AND fr.status = 'pending'
         ORDER BY fr.created_at DESC",
    )
    .bind(&user.id)
    .fetch_all(&pool)
    .await;

    match (friends, incoming, outgoing) {
        (Ok(friends), Ok(incoming), Ok(outgoing)) => {
            Json(json!({"friends": friends, "incoming": incoming, "outgoing": outgoing})).into_response()
        }
        (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => {
            tracing::error!(%error, "failed to load friend lists");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friends_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct FriendRequestInput {
    username: String,
}

async fn create_friend_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<FriendRequestInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let username = input.username.trim().to_lowercase();
    if username.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Enter the exact username of the person you want to add."}))).into_response();
    }

    let target = sqlx::query_as::<_, (String, String)>(
        "SELECT u.id, u.username
         FROM users u
         LEFT JOIN user_profiles up ON up.user_id = u.id
         WHERE (u.username_key = $1 OR lower(up.discord_username) = $1)
           AND u.status = 'active'
         LIMIT 1",
    )
    .bind(&username)
    .fetch_optional(&pool)
    .await;

    let target = match target {
        Ok(Some(target)) => target,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "No active user has that username."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "friend target lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_lookup_failed"}))).into_response();
        }
    };

    if target.0 == user.id {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "You cannot add yourself."}))).into_response();
    }

    let (low, high) = if user.id < target.0 {
        (user.id.clone(), target.0.clone())
    } else {
        (target.0.clone(), user.id.clone())
    };

    let already_friends = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM friendships WHERE user_low_id = $1 AND user_high_id = $2",
    )
    .bind(&low)
    .bind(&high)
    .fetch_optional(&pool)
    .await;

    match already_friends {
        Ok(Some(_)) => return (StatusCode::CONFLICT, Json(json!({"error": "You are already friends."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "friendship lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_lookup_failed"}))).into_response();
        }
        _ => {}
    }

    let reverse = sqlx::query_scalar::<_, String>(
        "SELECT id FROM friend_requests
         WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'",
    )
    .bind(&target.0)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;

    match reverse {
        Ok(Some(request_id)) => {
            let mut tx = match pool.begin().await {
                Ok(tx) => tx,
                Err(error) => {
                    tracing::error!(%error, "failed to start friend acceptance transaction");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_accept_failed"}))).into_response();
                }
            };
            let insert = sqlx::query(
                "INSERT INTO friendships(user_low_id, user_high_id, created_at)
                 VALUES($1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(&low)
            .bind(&high)
            .bind(now())
            .execute(&mut *tx)
            .await;
            let update = sqlx::query(
                "UPDATE friend_requests SET status = 'accepted', updated_at = $1 WHERE id = $2",
            )
            .bind(now())
            .bind(request_id)
            .execute(&mut *tx)
            .await;
            if let Err(error) = insert.and(update) {
                tracing::error!(%error, "failed to accept reverse friend request");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_accept_failed"}))).into_response();
            }
            if let Err(error) = tx.commit().await {
                tracing::error!(%error, "failed to commit friend acceptance");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_accept_failed"}))).into_response();
            }
            Json(json!({"ok": true, "accepted": true, "message": "Friend request accepted. You are now friends."})).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "reverse friend request lookup failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_lookup_failed"}))).into_response()
        }
        Ok(None) => {
            let result = sqlx::query(
                "INSERT INTO friend_requests(id, sender_id, recipient_id, status, created_at, updated_at)
                 VALUES($1, $2, $3, 'pending', $4, $4)
                 ON CONFLICT(sender_id, recipient_id)
                 DO UPDATE SET status = 'pending', updated_at = EXCLUDED.updated_at",
            )
            .bind(Uuid::new_v4().to_string())
            .bind(&user.id)
            .bind(&target.0)
            .bind(now())
            .execute(&pool)
            .await;
            match result {
                Ok(_) => (StatusCode::CREATED, Json(json!({"ok": true, "message": "Friend request sent."}))).into_response(),
                Err(error) => {
                    tracing::error!(%error, "failed to create friend request");
                    (StatusCode::CONFLICT, Json(json!({"error": "A friend request is already pending."}))).into_response()
                }
            }
        }
    }
}

async fn friend_action(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((target, action)): Path<(String, String)>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if target == user.id || !matches!(action.as_str(), "accept" | "decline" | "remove") {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid friend action."}))).into_response();
    }
    let (low, high) = if user.id < target {
        (user.id.clone(), target.clone())
    } else {
        (target.clone(), user.id.clone())
    };

    match action.as_str() {
        "accept" => {
            let request_id = sqlx::query_scalar::<_, String>(
                "SELECT id FROM friend_requests WHERE sender_id = $1 AND recipient_id = $2 AND status = 'pending'",
            )
            .bind(&target)
            .bind(&user.id)
            .fetch_optional(&pool)
            .await;
            let request_id = match request_id {
                Ok(Some(id)) => id,
                Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "That friend request is no longer pending."}))).into_response(),
                Err(error) => {
                    tracing::error!(%error, "friend request lookup failed");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
                }
            };
            let mut tx = match pool.begin().await {
                Ok(tx) => tx,
                Err(error) => {
                    tracing::error!(%error, "friend acceptance transaction failed");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
                }
            };
            let result = sqlx::query(
                "INSERT INTO friendships(user_low_id, user_high_id, created_at)
                 VALUES($1, $2, $3) ON CONFLICT DO NOTHING",
            )
            .bind(&low)
            .bind(&high)
            .bind(now())
            .execute(&mut *tx)
            .await
            .map(|_| ());
            let result = match result {
                Ok(()) => sqlx::query("UPDATE friend_requests SET status = 'accepted', updated_at = $1 WHERE id = $2")
                    .bind(now())
                    .bind(request_id)
                    .execute(&mut *tx)
                    .await
                    .map(|_| ()),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                tracing::error!(%error, "friend acceptance failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
            }
            if let Err(error) = tx.commit().await {
                tracing::error!(%error, "friend acceptance commit failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
            }
            Json(json!({"ok": true})).into_response()
        }
        "decline" => {
            let result = sqlx::query(
                "UPDATE friend_requests SET status = 'declined', updated_at = $1
                 WHERE sender_id = $2 AND recipient_id = $3 AND status = 'pending'",
            )
            .bind(now())
            .bind(&target)
            .bind(&user.id)
            .execute(&pool)
            .await;
            match result {
                Ok(result) if result.rows_affected() > 0 => Json(json!({"ok": true})).into_response(),
                Ok(_) => (StatusCode::NOT_FOUND, Json(json!({"error": "Friend request not found."}))).into_response(),
                Err(error) => {
                    tracing::error!(%error, "friend request decline failed");
                    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response()
                }
            }
        }
        "remove" => {
            let mut tx = match pool.begin().await {
                Ok(tx) => tx,
                Err(error) => {
                    tracing::error!(%error, "friend removal transaction failed");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
                }
            };
            let removed = sqlx::query("DELETE FROM friendships WHERE user_low_id = $1 AND user_high_id = $2")
                .bind(&low)
                .bind(&high)
                .execute(&mut *tx)
                .await;
            let friendship_existed = match removed {
                Ok(result) => result.rows_affected() > 0,
                Err(error) => {
                    tracing::error!(%error, "friend removal failed");
                    return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
                }
            };
            let requests = sqlx::query(
                "DELETE FROM friend_requests
                 WHERE (sender_id = $1 AND recipient_id = $2)
                    OR (sender_id = $2 AND recipient_id = $1)",
            )
            .bind(&user.id)
            .bind(&target)
            .execute(&mut *tx)
            .await;
            if let Err(error) = requests {
                tracing::error!(%error, "friend request cleanup failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
            }
            let conversations = sqlx::query(
                "DELETE FROM dm_conversations WHERE user_low_id = $1 AND user_high_id = $2",
            )
            .bind(&low)
            .bind(&high)
            .execute(&mut *tx)
            .await;
            if let Err(error) = conversations {
                tracing::error!(%error, "DM cleanup failed after friend removal");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
            }
            if let Err(error) = tx.commit().await {
                tracing::error!(%error, "friend removal commit failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "friend_action_failed"}))).into_response();
            }
            if !friendship_existed {
                return (StatusCode::NOT_FOUND, Json(json!({"error": "Friendship not found."}))).into_response();
            }
            Json(json!({"ok": true})).into_response()
        }
        _ => (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid friend action."}))).into_response(),
    }
}

#[derive(Serialize, FromRow)]
struct DmConversationView {
    id: String,
    updated_at: i64,
    user_id: String,
    username: String,
    display_name: String,
    avatar_url: Option<String>,
    last_message: Option<String>,
    last_message_at: Option<i64>,
}

async fn list_dms(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let rows = sqlx::query_as::<_, DmConversationView>(
        "SELECT c.id, c.updated_at,
                CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END AS user_id,
                u.username, COALESCE(up.display_name, u.username) AS display_name, up.avatar_url,
                (SELECT content FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message,
                (SELECT created_at FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) AS last_message_at
         FROM dm_conversations c
         JOIN users u ON u.id = CASE WHEN c.user_low_id = $1 THEN c.user_high_id ELSE c.user_low_id END
         LEFT JOIN user_profiles up ON up.user_id = u.id
         WHERE c.user_low_id = $1 OR c.user_high_id = $1
         ORDER BY c.updated_at DESC",
    )
    .bind(&user.id)
    .fetch_all(&pool)
    .await;

    match rows {
        Ok(conversations) => Json(json!({"conversations": conversations})).into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to load direct message conversations");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct OpenDmInput {
    user_id: String,
}

async fn open_dm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<OpenDmInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let target = input.user_id.trim();
    if target.is_empty() || target == user.id {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Choose another user."}))).into_response();
    }
    let (low, high) = if user.id.as_str() < target {
        (user.id.clone(), target.to_owned())
    } else {
        (target.to_owned(), user.id.clone())
    };
    let friendship = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM friendships WHERE user_low_id = $1 AND user_high_id = $2",
    )
    .bind(&low)
    .bind(&high)
    .fetch_optional(&pool)
    .await;
    match friendship {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::FORBIDDEN, Json(json!({"error": "You can only message friends."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "friendship check for DM failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_open_failed"}))).into_response();
        }
    }

    let result = sqlx::query(
        "INSERT INTO dm_conversations(id, user_low_id, user_high_id, created_at, updated_at)
         VALUES($1, $2, $3, $4, $4) ON CONFLICT(user_low_id, user_high_id) DO NOTHING",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(&low)
    .bind(&high)
    .bind(now())
    .execute(&pool)
    .await;
    if let Err(error) = result {
        tracing::error!(%error, "failed to create DM conversation");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_open_failed"}))).into_response();
    }

    let conversation = sqlx::query_scalar::<_, String>(
        "SELECT id FROM dm_conversations WHERE user_low_id = $1 AND user_high_id = $2",
    )
    .bind(&low)
    .bind(&high)
    .fetch_one(&pool)
    .await;
    match conversation {
        Ok(id) => (StatusCode::CREATED, Json(json!({"conversation": {"id": id, "user_id": target}}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to retrieve DM conversation");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_open_failed"}))).into_response()
        }
    }
}

#[derive(Serialize, FromRow)]
struct DmMessageView {
    id: String,
    content: String,
    created_at: i64,
    author_id: String,
    username: String,
    display_name: String,
    avatar_url: Option<String>,
}

async fn dm_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let conversation = sqlx::query_scalar::<_, String>(
        "SELECT id FROM dm_conversations
         WHERE id = $1 AND (user_low_id = $2 OR user_high_id = $2)",
    )
    .bind(&conversation_id)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    match conversation {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Direct message conversation not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "DM conversation access check failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_lookup_failed"}))).into_response();
        }
    }

    let rows = sqlx::query_as::<_, DmMessageView>(
        "SELECT m.id, m.content, m.created_at, m.author_id, u.username,
                COALESCE(up.display_name, u.username) AS display_name, up.avatar_url
         FROM (
             SELECT * FROM dm_messages
             WHERE conversation_id = $1
             ORDER BY created_at DESC
             LIMIT 75
         ) m
         JOIN users u ON u.id = m.author_id
         LEFT JOIN user_profiles up ON up.user_id = u.id
         ORDER BY m.created_at ASC",
    )
    .bind(&conversation_id)
    .fetch_all(&pool)
    .await;

    match rows {
        Ok(messages) => Json(json!({"messages": messages})).into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to load DM messages");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_messages_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct SendDmInput {
    content: String,
}

async fn send_dm(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Json(input): Json<SendDmInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let conversation = sqlx::query_scalar::<_, String>(
        "SELECT id FROM dm_conversations
         WHERE id = $1 AND (user_low_id = $2 OR user_high_id = $2)",
    )
    .bind(&conversation_id)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    match conversation {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Direct message conversation not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "DM conversation access check failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_lookup_failed"}))).into_response();
        }
    }

    let content = input.content.trim();
    let length = content.chars().count();
    if length == 0 || length > 4000 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Messages must contain 1–4000 characters."}))).into_response();
    }
    let id = Uuid::new_v4().to_string();
    let created_at = now();
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "DM send transaction failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_send_failed"}))).into_response();
        }
    };
    let inserted = sqlx::query(
        "INSERT INTO dm_messages(id, conversation_id, author_id, content, created_at)
         VALUES($1, $2, $3, $4, $5)",
    )
    .bind(&id)
    .bind(&conversation_id)
    .bind(&user.id)
    .bind(content)
    .bind(created_at)
    .execute(&mut *tx)
    .await;
    if let Err(error) = inserted {
        tracing::error!(%error, "DM message insert failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_send_failed"}))).into_response();
    }
    let updated = sqlx::query("UPDATE dm_conversations SET updated_at = $1 WHERE id = $2")
        .bind(created_at)
        .bind(&conversation_id)
        .execute(&mut *tx)
        .await;
    if let Err(error) = updated {
        tracing::error!(%error, "DM conversation update failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_send_failed"}))).into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "DM send commit failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "dm_send_failed"}))).into_response();
    }

    let message = json!({
        "id": id,
        "content": content,
        "created_at": created_at,
        "author_id": user.id.clone(),
        "username": user.username.clone(),
        "display_name": user.username.clone()
    });
    let recipients = sqlx::query_as::<_, (String, String)>(
        "SELECT user_low_id, user_high_id FROM dm_conversations WHERE id = $1",
    )
    .bind(&conversation_id)
    .fetch_optional(&pool)
    .await;
    if let Ok(Some((low_id, high_id))) = recipients {
        let _ = state.realtime.send(json!({
            "type": "dm.message.created",
            "conversation_id": conversation_id,
            "recipient_ids": [low_id, high_id],
            "message": message.clone()
        }));
    }
    (StatusCode::CREATED, Json(json!({"message": message}))).into_response()
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/friends", get(list_friends))
        .route("/api/friends/request", post(create_friend_request))
        .route("/api/friends/{target}/{action}", post(friend_action))
        .route("/api/dms", get(list_dms))
        .route("/api/dms/open", post(open_dm))
        .route(
            "/api/dms/{conversation_id}/messages",
            get(dm_messages).post(send_dm),
        )
}
