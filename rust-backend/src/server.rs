use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use uuid::Uuid;
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

pub(crate) async fn channel_permission_allowed(
    pool: &PgPool,
    user_id: &str,
    channel_id: &str,
    permission: &str,
) -> Result<bool, sqlx::Error> {
    let allowed = sqlx::query_scalar::<_, bool>(
        "WITH channel AS (
             SELECT id, server_id FROM channels WHERE id = $1
         ),
         member_role_ids AS (
             SELECT mr.role_id
             FROM member_roles mr
             JOIN channel c ON c.server_id = mr.server_id
             WHERE mr.user_id = $2
             UNION
             SELECT r.id
             FROM roles r
             JOIN channel c ON c.server_id = r.server_id
             WHERE r.name = '@everyone'
         )
         SELECT CASE
             WHEN NOT EXISTS (
                 SELECT 1 FROM memberships m
                 JOIN channel c ON c.server_id = m.server_id
                 WHERE m.user_id = $2
             ) THEN FALSE
             WHEN EXISTS (
                 SELECT 1 FROM channel_permissions cp
                 JOIN channel c ON c.id = cp.channel_id
                 WHERE cp.target_type = 'user'
                   AND cp.target_id = $2
                   AND cp.deny_json::jsonb ? $3
             ) THEN FALSE
             WHEN EXISTS (
                 SELECT 1 FROM channel_permissions cp
                 JOIN channel c ON c.id = cp.channel_id
                 WHERE cp.target_type = 'user'
                   AND cp.target_id = $2
                   AND cp.allow_json::jsonb ? $3
             ) THEN TRUE
             WHEN EXISTS (
                 SELECT 1 FROM channel_permissions cp
                 JOIN channel c ON c.id = cp.channel_id
                 JOIN member_role_ids mr ON mr.role_id = cp.target_id
                 WHERE cp.target_type = 'role'
                   AND cp.allow_json::jsonb ? $3
             ) THEN TRUE
             WHEN EXISTS (
                 SELECT 1 FROM channel_permissions cp
                 JOIN channel c ON c.id = cp.channel_id
                 JOIN member_role_ids mr ON mr.role_id = cp.target_id
                 WHERE cp.target_type = 'role'
                   AND cp.deny_json::jsonb ? $3
             ) THEN FALSE
             ELSE TRUE
         END
         FROM channel",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(permission)
    .fetch_optional(pool)
    .await?;

    Ok(allowed.unwrap_or(false))
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
                s.is_system::BIGINT AS is_system, m.joined_at
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
        Err(response) => return *response,
    };
    if let Err(response) = require_membership(&pool, &user, &server_id).await {
        return *response;
    }

    let rows = sqlx::query_as::<_, ChannelView>(
        "WITH member_role_ids AS (
             SELECT role_id FROM member_roles WHERE server_id = $1 AND user_id = $2
             UNION
             SELECT id FROM roles WHERE server_id = $1 AND name = '@everyone'
         )
         SELECT c.id, c.name, c.kind, c.position::BIGINT AS position, c.section_id,
                ss.name AS section_name, d.category_name, d.discord_channel_id
         FROM channels c
         LEFT JOIN discord_channel_links d
           ON d.mallow_channel_id = c.id AND d.server_id = c.server_id
         LEFT JOIN server_sections ss ON ss.id = c.section_id
         WHERE c.server_id = $1
           AND NOT EXISTS (
               SELECT 1 FROM channel_permissions cp
               WHERE cp.channel_id = c.id
                 AND cp.target_type = 'user'
                 AND cp.target_id = $2
                 AND cp.deny_json::jsonb ? 'view_channel'
           )
           AND (
               EXISTS (
                   SELECT 1 FROM channel_permissions cp
                   WHERE cp.channel_id = c.id
                     AND cp.target_type = 'user'
                     AND cp.target_id = $2
                     AND cp.allow_json::jsonb ? 'view_channel'
               )
               OR EXISTS (
                   SELECT 1 FROM channel_permissions cp
                   JOIN member_role_ids mr ON mr.role_id = cp.target_id
                   WHERE cp.channel_id = c.id
                     AND cp.target_type = 'role'
                     AND cp.allow_json::jsonb ? 'view_channel'
               )
               OR NOT EXISTS (
                   SELECT 1 FROM channel_permissions cp
                   JOIN member_role_ids mr ON mr.role_id = cp.target_id
                   WHERE cp.channel_id = c.id
                     AND cp.target_type = 'role'
                     AND cp.deny_json::jsonb ? 'view_channel'
               )
           )
         ORDER BY COALESCE(ss.position, 999), COALESCE(d.category_name, ss.name), c.position",
    )
    .bind(&server_id)
    .bind(&user.id)
    .fetch_all(&pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            tracing::error!(%error, "failed to list server channels with permissions");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channels_lookup_failed"}))).into_response();
        }
    };

    Json(json!({"channels": rows})).into_response()
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
        Err(response) => return *response,
    };
    let (owner_id, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let _ = owner_id;
    let roles = sqlx::query_as::<_, RoleView>(
        "SELECT id, name, is_system, position::BIGINT AS position, pingable::BIGINT AS pingable, COALESCE(color, '#99aab5') AS color
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
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
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
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
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
        Err(response) => return *response,
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


#[derive(Deserialize)]
struct CreateRoleInput {
    name: String,
}

async fn create_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<CreateRoleInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let name = input.name.trim();
    if name.chars().count() < 2 || name.chars().count() > 32
        || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == ' ' || ch == '_' || ch == '-')
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Role names must be 2–32 letters, numbers, spaces, _ or -."}))).into_response();
    }
    let position = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(position), 1) + 1 FROM roles WHERE server_id = $1",
    )
    .bind(&server_id)
    .fetch_one(&pool)
    .await;
    let position = match position {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(%error, "role position lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "role_create_failed"}))).into_response();
        }
    };
    let id = Uuid::new_v4().to_string();
    match sqlx::query(
        "INSERT INTO roles(id, server_id, name, is_system, position) VALUES($1, $2, $3, 0, $4)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(name)
    .bind(position)
    .execute(&pool)
    .await
    {
        Ok(_) => (StatusCode::CREATED, Json(json!({"role": {"id": id, "name": name, "is_system": 0, "position": position}}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "role create failed");
            (StatusCode::CONFLICT, Json(json!({"error": "A role with that name already exists."}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct UpdateRoleInput {
    name: Option<String>,
    color: Option<String>,
    pingable: Option<bool>,
    remove: Option<bool>,
}

async fn update_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((server_id, role_id)): Path<(String, String)>,
    Json(input): Json<UpdateRoleInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let role = sqlx::query_scalar::<_, i64>(
        "SELECT is_system FROM roles WHERE id = $1 AND server_id = $2",
    )
    .bind(&role_id)
    .bind(&server_id)
    .fetch_optional(&pool)
    .await;
    let is_system = match role {
        Ok(Some(value)) => value != 0,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Role not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "role lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "role_update_failed"}))).into_response();
        }
    };

    if input.remove.unwrap_or(false) {
        if is_system {
            return (StatusCode::FORBIDDEN, Json(json!({"error": "System roles cannot be deleted."}))).into_response();
        }
        return match sqlx::query("DELETE FROM roles WHERE id = $1 AND server_id = $2")
            .bind(&role_id)
            .bind(&server_id)
            .execute(&pool)
            .await
        {
            Ok(_) => Json(json!({"ok": true})).into_response(),
            Err(error) => {
                tracing::error!(%error, "role deletion failed");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "role_update_failed"}))).into_response()
            }
        };
    }

    if let Some(color) = input.color {
        if color.len() != 7 || !color.starts_with('#') || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": "Role color must be a six-digit hex color."}))).into_response();
        }
        return match sqlx::query("UPDATE roles SET color = $1 WHERE id = $2 AND server_id = $3")
            .bind(color.to_lowercase())
            .bind(&role_id)
            .bind(&server_id)
            .execute(&pool)
            .await
        {
            Ok(_) => Json(json!({"ok": true, "color": color.to_lowercase()})).into_response(),
            Err(error) => {
                tracing::error!(%error, "role color update failed");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "role_update_failed"}))).into_response()
            }
        };
    }

    if let Some(pingable) = input.pingable {
        let value = if pingable { 1_i64 } else { 0_i64 };
        return match sqlx::query("UPDATE roles SET pingable = $1 WHERE id = $2 AND server_id = $3")
            .bind(value)
            .bind(&role_id)
            .bind(&server_id)
            .execute(&pool)
            .await
        {
            Ok(_) => Json(json!({"ok": true, "pingable": pingable})).into_response(),
            Err(error) => {
                tracing::error!(%error, "role ping setting update failed");
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "role_update_failed"}))).into_response()
            }
        };
    }

    if let Some(name) = input.name {
        if is_system {
            return (StatusCode::FORBIDDEN, Json(json!({"error": "System role names cannot be changed."}))).into_response();
        }
        let name = name.trim();
        if name.chars().count() < 2 || name.chars().count() > 32
            || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == ' ' || ch == '_' || ch == '-')
        {
            return (StatusCode::BAD_REQUEST, Json(json!({"error": "Role names must be 2–32 letters, numbers, spaces, _ or -."}))).into_response();
        }
        return match sqlx::query("UPDATE roles SET name = $1 WHERE id = $2 AND server_id = $3")
            .bind(name)
            .bind(&role_id)
            .bind(&server_id)
            .execute(&pool)
            .await
        {
            Ok(_) => Json(json!({"ok": true, "name": name})).into_response(),
            Err(error) => {
                tracing::error!(%error, "role name update failed");
                (StatusCode::CONFLICT, Json(json!({"error": "A role with that name already exists."}))).into_response()
            }
        };
    }
    (StatusCode::BAD_REQUEST, Json(json!({"error": "No role update was provided."}))).into_response()
}

#[derive(Deserialize)]
struct MemberRoleInput {
    role_id: String,
    remove: Option<bool>,
}

async fn update_member_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((server_id, target_id)): Path<(String, String)>,
    Json(input): Json<MemberRoleInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let member = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&server_id)
    .bind(&target_id)
    .fetch_optional(&pool)
    .await;
    let role_name = sqlx::query_scalar::<_, String>(
        "SELECT name FROM roles WHERE id = $1 AND server_id = $2",
    )
    .bind(&input.role_id)
    .bind(&server_id)
    .fetch_optional(&pool)
    .await;
    match (member, role_name) {
        (Ok(Some(_)), Ok(Some(name))) => {
            if name == "@everyone" {
                return (StatusCode::FORBIDDEN, Json(json!({"error": "The @everyone role is assigned automatically."}))).into_response();
            }
        }
        (Ok(_), Ok(None)) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Member or role not found."}))).into_response(),
        (Ok(None), Ok(Some(_))) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Member or role not found."}))).into_response(),
        (Err(error), _) | (_, Err(error)) => {
            tracing::error!(%error, "member role lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "member_role_update_failed"}))).into_response();
        }
    }
    let result = if input.remove.unwrap_or(false) {
        sqlx::query("DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3")
            .bind(&server_id)
            .bind(&target_id)
            .bind(&input.role_id)
            .execute(&pool)
            .await
    } else {
        sqlx::query("INSERT INTO member_roles(server_id, user_id, role_id) VALUES($1, $2, $3) ON CONFLICT DO NOTHING")
            .bind(&server_id)
            .bind(&target_id)
            .bind(&input.role_id)
            .execute(&pool)
            .await
    };
    match result {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "member role update failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "member_role_update_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct CreateChannelInput {
    name: String,
    kind: Option<String>,
    section_id: Option<String>,
}

async fn create_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<CreateChannelInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let mut name = String::new();
    let mut previous_dash = false;
    for ch in input.name.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            name.push(ch);
            previous_dash = false;
        } else if (ch == '-' || ch.is_whitespace() || ch == '_') && !previous_dash && !name.is_empty() {
            name.push('-');
            previous_dash = true;
        }
        if name.len() >= 50 {
            break;
        }
    }
    while name.ends_with('-') {
        name.pop();
    }
    if name.chars().count() < 2 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Channel name must be at least 2 characters."}))).into_response();
    }
    let kind = if input.kind.as_deref() == Some("voice") { "voice" } else { "text" };
    let section_id = input.section_id.filter(|value| !value.trim().is_empty());
    if let Some(section_id) = section_id.as_ref() {
        let section = sqlx::query_scalar::<_, String>(
            "SELECT id FROM server_sections WHERE id = $1 AND server_id = $2",
        )
        .bind(section_id)
        .bind(&server_id)
        .fetch_optional(&pool)
        .await;
        if !matches!(section, Ok(Some(_))) {
            return (StatusCode::NOT_FOUND, Json(json!({"error": "Section not found."}))).into_response();
        }
    }
    let position = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM channels WHERE server_id = $1",
    )
    .bind(&server_id)
    .fetch_one(&pool)
    .await;
    let position = match position {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(%error, "channel position lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_create_failed"}))).into_response();
        }
    };
    let id = Uuid::new_v4().to_string();
    match sqlx::query(
        "INSERT INTO channels(id, server_id, name, kind, position, section_id)
         VALUES($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(&name)
    .bind(kind)
    .bind(position)
    .bind(section_id)
    .execute(&pool)
    .await
    {
        Ok(_) => (StatusCode::CREATED, Json(json!({"channel": {"id": id, "name": name, "kind": kind, "position": position}}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "channel create failed");
            (StatusCode::CONFLICT, Json(json!({"error": "A channel with that name could not be created."}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct UpdateServerSettingsInput {
    name: Option<String>,
    icon_url: Option<String>,
}

async fn update_server_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<UpdateServerSettingsInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let current = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT name, icon_url FROM servers WHERE id = $1",
    )
    .bind(&server_id)
    .fetch_optional(&pool)
    .await;
    let (current_name, current_icon) = match current {
        Ok(Some(value)) => value,
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Server not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "server settings lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "server_update_failed"}))).into_response();
        }
    };
    let name = input.name.map(|value| value.trim().chars().take(50).collect::<String>()).unwrap_or(current_name);
    let icon = input.icon_url.map(|value| value.trim().to_owned()).unwrap_or_else(|| current_icon.unwrap_or_default());
    if name.chars().count() < 2 {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Server name must be at least 2 characters."}))).into_response();
    }
    if !icon.is_empty() && !icon.starts_with("https://") {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Server icon must be an HTTPS URL."}))).into_response();
    }
    match sqlx::query("UPDATE servers SET name = $1, icon_url = $2 WHERE id = $3")
        .bind(&name)
        .bind(if icon.is_empty() { None } else { Some(icon.as_str()) })
        .bind(&server_id)
        .execute(&pool)
        .await
    {
        Ok(_) => Json(json!({"ok": true, "server": {"id": server_id, "name": name, "icon_url": if icon.is_empty() { None } else { Some(icon) }}})).into_response(),
        Err(error) => {
            tracing::error!(%error, "server settings update failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "server_update_failed"}))).into_response()
        }
    }
}

#[derive(Serialize, FromRow)]
struct SectionView {
    id: String,
    name: String,
    position: i64,
}

async fn list_sections(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match sqlx::query_as::<_, SectionView>(
        "SELECT id, name, position::BIGINT AS position FROM server_sections WHERE server_id = $1 ORDER BY position, name",
    )
    .bind(&server_id)
    .fetch_all(&pool)
    .await
    {
        Ok(sections) => Json(json!({"sections": sections, "can_manage": manager})).into_response(),
        Err(error) => {
            tracing::error!(%error, "server sections lookup failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "sections_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct CreateSectionInput {
    name: String,
}

async fn create_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<CreateSectionInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let name = input.name.trim();
    if name.chars().count() < 2 || name.chars().count() > 40
        || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == ' ' || ch == '_' || ch == '-')
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Section names must be 2–40 letters, numbers, spaces, _ or -."}))).into_response();
    }
    let position = sqlx::query_scalar::<_, i64>(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM server_sections WHERE server_id = $1",
    )
    .bind(&server_id)
    .fetch_one(&pool)
    .await;
    let position = match position {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(%error, "section position lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "section_create_failed"}))).into_response();
        }
    };
    let id = Uuid::new_v4().to_string();
    match sqlx::query("INSERT INTO server_sections(id, server_id, name, position, created_at) VALUES($1, $2, $3, $4, $5)")
        .bind(&id)
        .bind(&server_id)
        .bind(name)
        .bind(position)
        .bind(now())
        .execute(&pool)
        .await
    {
        Ok(_) => (StatusCode::CREATED, Json(json!({"section": {"id": id, "name": name, "position": position}}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "section create failed");
            (StatusCode::CONFLICT, Json(json!({"error": "A section with that name already exists."}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct UpdateSectionInput {
    name: Option<String>,
    position: Option<i64>,
}

async fn update_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((server_id, section_id)): Path<(String, String)>,
    Json(input): Json<UpdateSectionInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let name = input.name.unwrap_or_default().trim().to_owned();
    if name.chars().count() < 2 || name.chars().count() > 40
        || !name.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == ' ' || ch == '_' || ch == '-')
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid section name."}))).into_response();
    }
    let position = input.position.unwrap_or(0).clamp(0, 500);
    match sqlx::query("UPDATE server_sections SET name = $1, position = $2 WHERE id = $3 AND server_id = $4")
        .bind(name)
        .bind(position)
        .bind(&section_id)
        .bind(&server_id)
        .execute(&pool)
        .await
    {
        Ok(result) if result.rows_affected() > 0 => Json(json!({"ok": true})).into_response(),
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({"error": "Section not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "section update failed");
            (StatusCode::CONFLICT, Json(json!({"error": "Section update failed."}))).into_response()
        }
    }
}

async fn delete_section(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((server_id, section_id)): Path<(String, String)>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "section deletion transaction failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "section_delete_failed"}))).into_response();
        }
    };
    let clear = sqlx::query("UPDATE channels SET section_id = NULL WHERE section_id = $1 AND server_id = $2")
        .bind(&section_id)
        .bind(&server_id)
        .execute(&mut *tx)
        .await;
    if let Err(error) = clear {
        tracing::error!(%error, "section channel unlink failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "section_delete_failed"}))).into_response();
    }
    let deleted = sqlx::query("DELETE FROM server_sections WHERE id = $1 AND server_id = $2")
        .bind(&section_id)
        .bind(&server_id)
        .execute(&mut *tx)
        .await;
    match deleted {
        Ok(result) if result.rows_affected() > 0 => {}
        Ok(_) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Section not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "section delete failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "section_delete_failed"}))).into_response();
        }
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "section delete commit failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "section_delete_failed"}))).into_response();
    }
    Json(json!({"ok": true})).into_response()
}

#[derive(Deserialize)]
struct PermissionOverwriteInput {
    target_type: String,
    target_id: String,
    allow: Vec<String>,
    deny: Vec<String>,
}

async fn channel_manager_context(
    state: &AppState,
    headers: &HeaderMap,
    channel_id: &str,
) -> Result<(PgPool, String), Box<Response>> {
    let (pool, user) = require_user(state, headers).await?;
    let server_id = sqlx::query_scalar::<_, String>(
        "SELECT server_id FROM channels WHERE id = $1",
    )
    .bind(channel_id)
    .fetch_optional(&pool)
    .await
    .map_err(|error| {
        tracing::error!(%error, "channel permission server lookup failed");
        Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_permissions_failed"}))).into_response())
    })?
    .ok_or_else(|| Box::new((StatusCode::NOT_FOUND, Json(json!({"error": "Channel not found."}))).into_response()))?;
    let (_, manager) = require_membership(&pool, &user, &server_id).await?;
    if !manager {
        return Err(Box::new((StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response()));
    }
    Ok((pool, server_id))
}

async fn get_channel_permissions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
) -> Response {
    let (pool, _) = match channel_manager_context(&state, &headers, &channel_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let rows = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT target_type, target_id, allow_json, deny_json
         FROM channel_permissions WHERE channel_id = $1",
    )
    .bind(&channel_id)
    .fetch_all(&pool)
    .await;
    match rows {
        Ok(rows) => Json(json!({"permissions": rows.into_iter().map(|(target_type, target_id, allow_json, deny_json)| json!({
            "target_type": target_type,
            "target_id": target_id,
            "allow": serde_json::from_str::<Vec<String>>(&allow_json).unwrap_or_default(),
            "deny": serde_json::from_str::<Vec<String>>(&deny_json).unwrap_or_default()
        })).collect::<Vec<_>>()})).into_response(),
        Err(error) => {
            tracing::error!(%error, "channel permission list failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_permissions_failed"}))).into_response()
        }
    }
}

async fn save_channel_permissions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    Json(input): Json<PermissionOverwriteInput>,
) -> Response {
    let (pool, server_id) = match channel_manager_context(&state, &headers, &channel_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let target_type = if input.target_type == "user" { "user" } else { "role" };
    let valid_permissions = ["view_channel", "send_messages", "read_message_history", "attach_files", "embed_links", "manage_messages"];
    if input.target_id.is_empty()
        || input.allow.iter().chain(input.deny.iter()).any(|value| !valid_permissions.contains(&value.as_str()))
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid permission overwrite."}))).into_response();
    }
    let target_exists = if target_type == "role" {
        sqlx::query_scalar::<_, String>("SELECT id FROM roles WHERE id = $1 AND server_id = $2")
            .bind(&input.target_id)
            .bind(&server_id)
            .fetch_optional(&pool)
            .await
    } else {
        sqlx::query_scalar::<_, String>("SELECT user_id FROM memberships WHERE user_id = $1 AND server_id = $2")
            .bind(&input.target_id)
            .bind(&server_id)
            .fetch_optional(&pool)
            .await
    };
    match target_exists {
        Ok(Some(_)) => {}
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Permission target is not part of this server."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "permission target lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_permissions_failed"}))).into_response();
        }
    }
    let allow = serde_json::to_string(&input.allow.into_iter().collect::<std::collections::BTreeSet<_>>()).unwrap_or_else(|_| "[]".to_owned());
    let deny = serde_json::to_string(&input.deny.into_iter().collect::<std::collections::BTreeSet<_>>()).unwrap_or_else(|_| "[]".to_owned());
    match sqlx::query(
        "INSERT INTO channel_permissions(channel_id, target_type, target_id, allow_json, deny_json, updated_at)
         VALUES($1, $2, $3, $4, $5, $6)
         ON CONFLICT(channel_id, target_type, target_id)
         DO UPDATE SET allow_json = EXCLUDED.allow_json, deny_json = EXCLUDED.deny_json, updated_at = EXCLUDED.updated_at",
    )
    .bind(&channel_id)
    .bind(target_type)
    .bind(&input.target_id)
    .bind(allow)
    .bind(deny)
    .bind(now())
    .execute(&pool)
    .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "channel permission update failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_permissions_failed"}))).into_response()
        }
    }
}

async fn delete_channel_permissions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    Json(input): Json<DeletePermissionInput>,
) -> Response {
    let (pool, _) = match channel_manager_context(&state, &headers, &channel_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let target_type = if input.target_type == "user" { "user" } else { "role" };
    match sqlx::query(
        "DELETE FROM channel_permissions WHERE channel_id = $1 AND target_type = $2 AND target_id = $3",
    )
    .bind(&channel_id)
    .bind(target_type)
    .bind(input.target_id)
    .execute(&pool)
    .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "channel permission delete failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "channel_permissions_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct DeletePermissionInput {
    target_type: String,
    target_id: String,
}

async fn delete_role(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((server_id, role_id)): Path<(String, String)>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, manager) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let is_system = sqlx::query_scalar::<_, i64>(
        "SELECT is_system FROM roles WHERE id = $1 AND server_id = $2",
    )
    .bind(&role_id)
    .bind(&server_id)
    .fetch_optional(&pool)
    .await;
    match is_system {
        Ok(Some(value)) if value != 0 => return (StatusCode::FORBIDDEN, Json(json!({"error": "System roles cannot be deleted."}))).into_response(),
        Ok(None) => return (StatusCode::NOT_FOUND, Json(json!({"error": "Role not found."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "role lookup failed before delete");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "role_delete_failed"}))).into_response();
        }
        _ => {}
    }
    match sqlx::query("DELETE FROM roles WHERE id = $1 AND server_id = $2")
        .bind(&role_id)
        .bind(&server_id)
        .execute(&pool)
        .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "role deletion failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "role_delete_failed"}))).into_response()
        }
    }
}

#[derive(FromRow, Serialize)]
struct ServerEmoji {
    id: String,
    name: String,
    image_url: String,
    created_at: i64,
}

async fn server_emoji_manager(
    pool: &PgPool,
    user: &AuthUser,
    server_id: &str,
) -> Result<bool, Box<Response>> {
    let owner_id = sqlx::query_scalar::<_, String>(
        "SELECT owner_id FROM servers WHERE id = $1",
    )
    .bind(server_id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        tracing::error!(%error, "emoji server lookup failed");
        Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "emoji_lookup_failed"}))).into_response())
    })?;
    let Some(owner_id) = owner_id else {
        return Err(Box::new((StatusCode::NOT_FOUND, Json(json!({"error": "Server not found."}))).into_response()));
    };
    let member = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2",
    )
    .bind(server_id)
    .bind(&user.id)
    .fetch_optional(pool)
    .await
    .map_err(|error| {
        tracing::error!(%error, "emoji membership lookup failed");
        Box::new((StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "emoji_lookup_failed"}))).into_response())
    })?;
    if member.is_none() {
        return Err(Box::new((StatusCode::FORBIDDEN, Json(json!({"error": "You are not a member of this server."}))).into_response()));
    }
    Ok(user.account_type == "owner" || owner_id == user.id)
}

fn valid_emoji_image_url(value: &str) -> bool {
    if value.len() <= 1000
        && value.get(..8).is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
        && !value.chars().any(char::is_whitespace)
    {
        return true;
    }
    if value.len() > 350_000 {
        return false;
    }
    let Some((header, encoded)) = value.split_once(',') else {
        return false;
    };
    let Some(mime) = header.strip_prefix("data:").and_then(|value| value.strip_suffix(";base64")) else {
        return false;
    };
    let Ok(bytes) = STANDARD.decode(encoded) else {
        return false;
    };
    if bytes.is_empty() || bytes.len() > 256 * 1024 {
        return false;
    }
    match mime {
        "image/png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "image/jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

async fn list_emojis(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let can_manage = match server_emoji_manager(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    match sqlx::query_as::<_, ServerEmoji>(
        "SELECT id, name, image_url, created_at FROM server_emojis
         WHERE server_id = $1 ORDER BY name",
    )
    .bind(&server_id)
    .fetch_all(&pool)
    .await
    {
        Ok(emojis) => Json(json!({"emojis": emojis, "can_manage": can_manage})).into_response(),
        Err(error) => {
            tracing::error!(%error, "server emoji list failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "emoji_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct CreateEmojiInput {
    name: String,
    image_url: String,
}

async fn create_emoji(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<CreateEmojiInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let manager = match server_emoji_manager(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let name = input.name.trim().to_ascii_lowercase();
    let image_url = input.image_url.trim();
    if !(2..=32).contains(&name.len())
        || !name.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Emoji names must be 2–32 letters, numbers or underscores."}))).into_response();
    }
    if !valid_emoji_image_url(image_url) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Use a direct HTTPS image URL or upload a PNG, JPG, GIF or WebP image up to 256 KB."}))).into_response();
    }
    let id = Uuid::new_v4().to_string();
    match sqlx::query(
        "INSERT INTO server_emojis(id, server_id, name, image_url, created_by, created_at)
         VALUES($1, $2, $3, $4, $5, $6)",
    )
    .bind(&id)
    .bind(&server_id)
    .bind(&name)
    .bind(image_url)
    .bind(&user.id)
    .bind(now())
    .execute(&pool)
    .await
    {
        Ok(_) => (
            StatusCode::CREATED,
            Json(json!({"emoji": {"id": id, "name": name, "image_url": image_url}})),
        )
            .into_response(),
        Err(error) if error.as_database_error().and_then(|db| db.code()).as_deref() == Some("23505") => {
            (StatusCode::CONFLICT, Json(json!({"error": "That emoji name already exists or could not be added."}))).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "server emoji creation failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "emoji_create_failed"}))).into_response()
        }
    }
}

async fn delete_emoji(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((server_id, emoji_id)): Path<(String, String)>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let manager = match server_emoji_manager(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    if !manager {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Server owner access required."}))).into_response();
    }
    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "emoji deletion transaction failed to start");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "emoji_delete_failed"}))).into_response();
        }
    };
    if let Err(error) = sqlx::query("DELETE FROM server_emojis WHERE id = $1 AND server_id = $2")
        .bind(&emoji_id)
        .bind(&server_id)
        .execute(&mut *tx)
        .await
    {
        tracing::error!(%error, "server emoji deletion failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "emoji_delete_failed"}))).into_response();
    }
    if let Err(error) = sqlx::query(
        "DELETE FROM message_reactions
         WHERE emoji = $1 AND message_id IN (
             SELECT m.id FROM messages m JOIN channels c ON c.id = m.channel_id
             WHERE c.server_id = $2
         )",
    )
    .bind(format!("custom:{emoji_id}"))
    .bind(&server_id)
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "server emoji reaction cleanup failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "emoji_delete_failed"}))).into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "emoji deletion transaction failed to commit");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "emoji_delete_failed"}))).into_response();
    }
    Json(json!({"ok": true})).into_response()
}


#[derive(serde::Serialize, sqlx::FromRow)]
struct OnboardingConfig {
    enabled: i32,
    welcome_text: String,
    rules_text: String,
}

#[derive(Deserialize)]
struct OnboardingUpdate {
    complete: Option<bool>,
    enabled: Option<bool>,
    welcome_text: Option<String>,
    rules_text: Option<String>,
}

async fn get_onboarding(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, can_manage) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };

    let config = match sqlx::query_as::<_, OnboardingConfig>(
        "SELECT enabled, welcome_text, rules_text
         FROM server_onboarding WHERE server_id = $1",
    )
    .bind(&server_id)
    .fetch_optional(&pool)
    .await
    {
        Ok(Some(config)) => config,
        Ok(None) => OnboardingConfig {
            enabled: 0,
            welcome_text: "Welcome! Please read the rules before chatting.".to_owned(),
            rules_text: "Be respectful. No spam or harassment.".to_owned(),
        },
        Err(error) => {
            tracing::error!(%error, "server onboarding configuration lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "onboarding_lookup_failed"})),
            )
                .into_response();
        }
    };

    let completed = match sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM onboarding_completions WHERE server_id = $1 AND user_id = $2",
    )
    .bind(&server_id)
    .bind(&user.id)
    .fetch_optional(&pool)
    .await
    {
        Ok(value) => value.is_some(),
        Err(error) => {
            tracing::error!(%error, "server onboarding completion lookup failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "onboarding_lookup_failed"})),
            )
                .into_response();
        }
    };

    Json(json!({
        "config": config,
        "completed": completed,
        "can_manage": can_manage
    }))
    .into_response()
}

async fn update_onboarding(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(server_id): Path<String>,
    Json(input): Json<OnboardingUpdate>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let (_, can_manage) = match require_membership(&pool, &user, &server_id).await {
        Ok(value) => value,
        Err(response) => return *response,
    };

    if input.complete == Some(true) {
        return match sqlx::query(
            "INSERT INTO onboarding_completions(server_id, user_id, completed_at)
             VALUES($1, $2, $3)
             ON CONFLICT(server_id, user_id) DO UPDATE
             SET completed_at = EXCLUDED.completed_at",
        )
        .bind(&server_id)
        .bind(&user.id)
        .bind(now())
        .execute(&pool)
        .await
        {
            Ok(_) => Json(json!({"ok": true})).into_response(),
            Err(error) => {
                tracing::error!(%error, "server onboarding completion update failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"error": "onboarding_update_failed"})),
                )
                    .into_response()
            }
        };
    }

    if !can_manage {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": "Server owner access required."})),
        )
            .into_response();
    }

    let welcome_text: String = input
        .welcome_text
        .unwrap_or_default()
        .trim()
        .chars()
        .take(1000)
        .collect();
    let rules_text: String = input
        .rules_text
        .unwrap_or_default()
        .trim()
        .chars()
        .take(3000)
        .collect();

    match sqlx::query(
        "INSERT INTO server_onboarding(server_id, enabled, welcome_text, rules_text, updated_at)
         VALUES($1, $2, $3, $4, $5)
         ON CONFLICT(server_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           welcome_text = EXCLUDED.welcome_text,
           rules_text = EXCLUDED.rules_text,
           updated_at = EXCLUDED.updated_at",
    )
    .bind(&server_id)
    .bind(i32::from(input.enabled.unwrap_or(false)))
    .bind(welcome_text)
    .bind(rules_text)
    .bind(now())
    .execute(&pool)
    .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "server onboarding configuration update failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "onboarding_update_failed"})),
            )
                .into_response()
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/servers", get(list_servers))
        .route("/api/servers/{server_id}/channels", get(list_channels).post(create_channel))
        .route("/api/servers/{server_id}/emojis", get(list_emojis).post(create_emoji))
        .route("/api/servers/{server_id}/emojis/{emoji_id}", axum::routing::delete(delete_emoji))
        .route("/api/servers/{server_id}/roles", get(list_roles).post(create_role))
        .route("/api/servers/{server_id}/roles/{role_id}", post(update_role).delete(delete_role))
        .route("/api/servers/{server_id}/members", get(list_members))
        .route("/api/servers/{server_id}/members/{target_id}/roles", post(update_member_role))
        .route("/api/servers/{server_id}/settings", get(get_server_settings).post(update_server_settings))
        .route("/api/servers/{server_id}/onboarding", get(get_onboarding).post(update_onboarding))
        .route("/api/servers/{server_id}/stats", get(get_server_stats))
        .route("/api/servers/{server_id}/sections", get(list_sections).post(create_section))
        .route("/api/servers/{server_id}/sections/{section_id}", patch(update_section).delete(delete_section))
        .route("/api/channels/{channel_id}/permissions", get(get_channel_permissions).post(save_channel_permissions).delete(delete_channel_permissions))
}


#[cfg(test)]
mod emoji_validation_tests {
    use super::valid_emoji_image_url;

    #[test]
    fn accepts_https_and_supported_image_data_urls() {
        assert!(valid_emoji_image_url("https://cdn.example.com/emoji.gif"));
        assert!(valid_emoji_image_url("data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="));
        assert!(valid_emoji_image_url("data:image/png;base64,iVBORw0KGgo="));
    }

    #[test]
    fn rejects_unsafe_or_invalid_emoji_images() {
        assert!(!valid_emoji_image_url("http://cdn.example.com/emoji.gif"));
        assert!(!valid_emoji_image_url("data:image/gif;base64,not-base64"));
        assert!(!valid_emoji_image_url("data:text/html;base64,PGgxPk5vPC9oMT4="));
        assert!(!valid_emoji_image_url("https://cdn.example.com/emoji with spaces.gif"));
    }
}
