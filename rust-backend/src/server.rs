use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Serialize;
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
            tracing::error!(%error, "server API session lookup failed");
            Err(Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            )
                .into_response()))
        }
    }
}

fn can_manage(user: &AuthUser, owner_id: &str) -> bool {
    user.account_type == "owner" || user.id == owner_id
}

async fn require_membership(
    pool: &PgPool,
    user: &AuthUser,
    server_id: &str,
) -> Result<(String, bool), Box<Response>> {
    let owner_id = sqlx::query_scalar::<_, String>(
        "SELECT owner_id FROM servers WHERE id = $1",
    )
    .bind(server_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        tracing::error!(%error, "server lookup failed");
        Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "server_lookup_failed"}))).into_response())
    })?
    .ok_or_else(|| Box::new((StatusCode::NOT_FOUND, Json(json!({"error": "Server not found."}))).into_response()))?;

    let member = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
    )
    .bind(server_id)
    .bind(&user.id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        tracing::error!(%error, "server membership lookup failed");
        Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "server_lookup_failed"}))).into_response())
    })?;
    if member.is_none() {
        return Err(Box::new((StatusCode::FORBIDDEN, Json(json!({"error": "You are not a member of this server."}))).into_response()));
    }
    Ok((owner_id.clone(), can_manage(user, &owner_id)))
}

async fn channel_permission_allowed(
    pool: &PgPool,
    user_id: &str,
    channel_id: &str,
    permission: &str,
) -> Result<bool, sqlx::Error> {
    let server_id = sqlx::query_scalar::<_, String>(
        "SELECT server_id FROM channels WHERE id = $1",
    )
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    let Some(server_id) = server_id else {
        return Ok(false);
    };

    let member = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&server_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?;
    if member.is_none() {
        return Ok(false);
    }

    let mut roles = sqlx::query_scalar::<_, String>(
        "SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&server_id)
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    if let Some(everyone) = sqlx::query_scalar::<_, String>(
        "SELECT id FROM roles WHERE server_id = $1 AND name = '@everyone' LIMIT 1",
    )
    .bind(&server_id)
    .fetch_optional(pool)
    .await?
    {
        roles.push(everyone);
    }

    let overwrites = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT target_type, target_id, allow_json, deny_json
         FROM channel_permissions WHERE channel_id = $1",
    )
    .bind(channel_id)
    .fetch_all(pool)
    .await?;

    let parse = |value: &str| serde_json::from_str::<Vec<String>>(value).unwrap_or_default();
    let user_rows: Vec<_> = overwrites
        .iter()
        .filter(|row| row.0 == "user" && row.1 == user_id)
        .collect();
    let role_rows: Vec<_> = overwrites
        .iter()
        .filter(|row| row.0 == "role" && roles.iter().any(|role| role == &row.1))
        .collect();

    if user_rows.iter().any(|row| parse(&row.3).iter().any(|value| value == permission)) {
        return Ok(false);
    }
    if user_rows.iter().any(|row| parse(&row.2).iter().any(|value| value == permission)) {
        return Ok(true);
    }
    if role_rows.iter().any(|row| parse(&row.2).iter().any(|value| value == permission)) {
        return Ok(true);
    }
    if role_rows.iter().any(|row| parse(&row.3).iter().any(|value| value == permission)) {
        return Ok(false);
    }
    Ok(true)
}

#[derive(Serialize, FromRow)]
struct ServerView {
    id: String,
    name: String,
    icon_url: Option<String>,
    is_system: i64,
    joined_at: i64,
}

async fn list_servers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let default_icon = std::env::var("MALLOWCORD_DEFAULT_SERVER_ICON")
        .unwrap_or_else(|_| "https://raw.githubusercontent.com/WebsiteDevelopmentStudios/Mallow-Bot/main/MallowBot.png".to_owned());
    let rows = sqlx::query_as::<_, ServerView>(
        "SELECT s.id, s.name, COALESCE(s.icon_url, $1) AS icon_url,
                s.is_system, m.joined_at
         FROM memberships m
         JOIN servers s ON s.id = m.server_id
         WHERE m.user_id = $2
         ORDER BY s.is_system DESC, s.name",
    )
    .bind(default_icon)
    .bind(&user.id)
    .fetch_all(&pool)
    .await;

    match rows {
        Ok(servers) => Json(json!({"servers": servers})).into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to list MallowCord servers");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "servers_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Serialize, FromRow)]
struct ChannelView {
    id: String,
    name: String,
    kind: String,
    position: i64,
    section_id: Option<String>,
    section_name: Option<String>,
    category_name: Option<String>,
    discord_channel_id: Option<String>,
}

async fn list_channels(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Err(response) = require_membership(&pool, &user, &server_id).await {
        return *response;
    }

    let rows = sqlx::query_as::<_, ChannelView>(
        "SELECT c.id, c.name, c.kind, c.position, c.section_id,
                ss.name AS section_name, d.category_name, d.discord_channel_id
         FROM channels c
         LEFT JOIN discord_channel_links d
           ON d.mallow_channel_id = c.id AND d.server_id = c.server_id
         LEFT JOIN server_sections ss ON ss.id = c.section_id
         WHERE c.server_id = $1
         ORDER BY COALESCE(ss.position, 999), COALESCE(d.category_name, ss.name), c.position",
    )
    .bind(&server_id)
    .fetch_all(&pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "failed to list server channels");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channels_lookup_failed"}))).into_response();
        }
    };

    let mut visible = Vec::new();
    for channel in rows {
        match channel_permission_allowed(&pool, &user.id, &channel.id, "view_channel").await {
            Ok(true) => visible.push(channel),
            Ok(false) => {}
            Err(error) => {
                tracing::error!(%error, channel_id = %channel.id, "channel permission check failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_permissions_failed"}))).into_response();
            }
        }
    }
    Json(json!({"channels": visible})).into_response()
}

#[derive(Serialize, FromRow)]
struct RoleView {
    id: String,
    name: String,
    is_system: i32,
    position: i64,
    pingable: i64,
    color: String,
}

async fn list_roles(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (owner_id, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let _ = owner_id;
    let roles = sqlx::query_as::<_, RoleView>(
        "SELECT id, name, is_system, position, pingable, COALESCE(color, '#99aab5') AS color
         FROM roles WHERE server_id = $1 ORDER BY position DESC, name",
    )
    .bind(&server_id)
    .fetch_all(&pool)
    .await;
    match roles {
        Ok(roles) => Json(json!({"roles": roles, "can_manage": manager})).into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to list server roles");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "roles_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Serialize, FromRow)]
struct MemberView {
    id: String,
    username: String,
    display_name: String,
    avatar_url: Option<String>,
    bio: Option<String>,
    pronouns: Option<String>,
    presence: String,
    account_type: String,
    status: String,
    joined_at: i64,
    roles: String,
    roles_json: String,
}

async fn list_members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return response,
    };

    let members = sqlx::query_as::<_, MemberView>(
        "SELECT u.id,
                COALESCE(up.discord_username, u.username) AS username,
                COALESCE(up.display_name, u.username) AS display_name,
                up.avatar_url, up.bio, up.pronouns,
                CASE
                    WHEN COALESCE((pref.settings_json::jsonb #>> '{privacy,showOnlineStatus}')::boolean, true) = false THEN 'offline'
                    WHEN COALESCE(pr.last_seen_at, 0) >= $1 THEN COALESCE(up.status, 'online')
                    ELSE 'offline'
                END AS presence,
                u.account_type, u.status, m.joined_at,
                COALESCE((
                    SELECT string_agg(r.name, ', ')
                    FROM member_roles mr
                    JOIN roles r ON r.id = mr.role_id
                    WHERE mr.server_id = m.server_id AND mr.user_id = m.user_id
                ), '@everyone') AS roles,
                COALESCE((
                    SELECT json_agg(json_build_object(
                        'id', r.id, 'name', r.name,
                        'color', COALESCE(r.color, '#99aab5'),
                        'position', r.position
                    ))::text
                    FROM member_roles mr
                    JOIN roles r ON r.id = mr.role_id
                    WHERE mr.server_id = m.server_id AND mr.user_id = m.user_id
                ), '[]') AS roles_json
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN user_profiles up ON up.user_id = u.id
         LEFT JOIN user_presence pr ON pr.user_id = u.id
         LEFT JOIN user_preferences pref ON pref.user_id = u.id
         WHERE m.server_id = $2
         ORDER BY m.joined_at",
    )
    .bind(now() - 45)
    .bind(&server_id)
    .fetch_all(&pool)
    .await;

    match members {
        Ok(members) => Json(json!({"members": members, "can_manage": manager})).into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to list server members");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "members_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Serialize, FromRow)]
struct ServerSettings {
    id: String,
    name: String,
    icon_url: Option<String>,
    is_system: i32,
    owner_id: String,
    created_at: i64,
}

async fn get_server_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let server = sqlx::query_as::<_, ServerSettings>(
        "SELECT id, name, icon_url, is_system, owner_id, created_at
         FROM servers WHERE id = $1",
    )
    .bind(&server_id)
    .fetch_optional(&pool)
    .await;
    match server {
        Ok(Some(server)) => Json(json!({"server": server, "can_manage": manager})).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({"error": "Server not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "server settings lookup failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "server_lookup_failed"}))).into_response()
        }
    }
}

async fn get_server_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if let Err(response) = require_membership(&pool, &user, &server_id).await {
        return *response;
    }

    let stats = sqlx::query_as::<_, (i64, i64, i64, i64, i64)>(
        "SELECT
            (SELECT COUNT(*) FROM memberships WHERE server_id = $1),
            (SELECT COUNT(*) FROM channels WHERE server_id = $1),
            (SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.server_id = $1),
            (SELECT COUNT(*) FROM roles WHERE server_id = $1),
            (SELECT created_at FROM servers WHERE id = $1)",
    )
    .bind(&server_id)
    .fetch_one(&pool)
    .await;

    match stats {
        Ok((members, channels, messages, roles, created_at)) => Json(json!({
            "stats": {"members": members, "channels": channels, "messages": messages, "roles": roles, "created_at": created_at}
        }))
        .into_response(),
        Err(error) => {
            tracing::error!(%error, "server statistics query failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "server_stats_failed"}))).into_response()
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/servers", get(list_servers))
        .route("/api/servers/{server_id}/channels", get(list_channels))
        .route("/api/servers/{server_id}/roles", get(list_roles))
        .route("/api/servers/{server_id}/members", get(list_members))
        .route("/api/servers/{server_id}/settings", get(get_server_settings))
        .route("/api/servers/{server_id}/stats", get(get_server_stats))
}
