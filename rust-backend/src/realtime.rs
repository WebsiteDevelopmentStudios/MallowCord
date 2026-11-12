use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header::ORIGIN, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{collections::HashMap, time::{Duration, Instant}};
use tokio::sync::broadcast;

const VISIBILITY_CACHE_TTL: Duration = Duration::from_secs(3);
type VisibilityCache = HashMap<String, (bool, Instant)>;

use crate::{
    auth::{current_user, AuthUser},
    server::channel_permission_allowed,
    AppState,
};

fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(ORIGIN).and_then(|value| value.to_str().ok()) else {
        return false;
    };
    let configured = std::env::var("MALLOWCORD_ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "https://mallowcord-web.onrender.com".to_owned());
    configured
        .split(',')
        .map(str::trim)
        .any(|allowed| !allowed.is_empty() && allowed == origin)
}

async fn authorize(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(PgPool, AuthUser), Box<Response>> {
    let Some(pool) = state.database.as_ref() else {
        return Err(Box::new((StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "database_not_configured"}))).into_response()));
    };
    match current_user(headers, pool).await {
        Ok(Some(user)) if user.status != "timed_out" || user.timeout_until.unwrap_or(0) <= chrono::Utc::now().timestamp() => {
            Ok((pool.clone(), user))
        }
        Ok(Some(_)) => Err(Box::new((StatusCode::FORBIDDEN, Json(json!({"error": "Your account is timed out."}))).into_response())),
        Ok(None) => Err(Box::new((StatusCode::UNAUTHORIZED, Json(json!({"error": "Sign in required."}))).into_response())),
        Err(error) => {
            tracing::error!(%error, "websocket session lookup failed");
            Err(Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "session_lookup_failed"}))).into_response()))
        }
    }
}

async fn event_visible(pool: &PgPool, user: &AuthUser, event: &Value, cache: &mut VisibilityCache) -> bool {
    if event
        .get("recipient_ids")
        .and_then(Value::as_array)
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(user.id.as_str())))
    {
        return true;
    }

    if let Some(channel_id) = event.get("channel_id").and_then(Value::as_str) {
        let key = format!("channel:{channel_id}");
        if let Some((allowed, expires_at)) = cache.get(&key) {
            if *expires_at > Instant::now() {
                return *allowed;
            }
        }
        let allowed = matches!(
            channel_permission_allowed(pool, &user.id, channel_id, "view_channel").await,
            Ok(true)
        );
        remember_visibility(cache, key, allowed);
        return allowed;
    }

    if let Some(server_id) = event.get("server_id").and_then(Value::as_str) {
        let key = format!("server:{server_id}");
        if let Some((allowed, expires_at)) = cache.get(&key) {
            if *expires_at > Instant::now() {
                return *allowed;
            }
        }
        let allowed = matches!(
            sqlx::query_scalar::<_, i32>(
                "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
            )
            .bind(server_id)
            .bind(&user.id)
            .fetch_optional(pool)
            .await,
            Ok(Some(_))
        );
        remember_visibility(cache, key, allowed);
        return allowed;
    }
    false
}

fn remember_visibility(cache: &mut VisibilityCache, key: String, allowed: bool) {
    let now = Instant::now();
    if cache.len() >= 256 {
        cache.retain(|_, (_, expires_at)| *expires_at > now);
    }
    if cache.len() >= 512 {
        cache.clear();
    }
    cache.insert(key, (allowed, now + VISIBILITY_CACHE_TTL));
}

async fn websocket(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "WebSocket origin is not allowed."}))).into_response();
    }
    let (pool, user) = match authorize(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    upgrade
        .max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| handle_socket(socket, state, pool, user))
}

async fn handle_socket(
    mut socket: WebSocket,
    state: AppState,
    pool: PgPool,
    user: AuthUser,
) {
    let mut receiver = state.realtime.subscribe();
    let mut visibility_cache = VisibilityCache::new();
    let welcome = json!({"type": "connected", "user_id": user.id.clone()});
    if socket.send(Message::Text(welcome.to_string().into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) if text.as_str() == "ping" => {
                        if socket.send(Message::Text("pong".into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Text(_))) | Some(Ok(Message::Binary(_))) | Some(Ok(Message::Pong(_))) => {}
                }
            }
            event = receiver.recv() => {
                match event {
                    Ok(event) => {
                        if event_visible(&pool, &user, &event, &mut visibility_cache).await
                            && socket.send(Message::Text(event.to_string().into())).await.is_err()
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let resync = json!({"type": "resync.required"});
                        if socket.send(Message::Text(resync.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/api/realtime", get(websocket))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_rejects_requests_without_an_origin() {
        assert!(!origin_allowed(&HeaderMap::new()));
    }
}
