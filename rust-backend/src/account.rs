use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
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
) -> Result<(PgPool, AuthUser), Response> {
    let Some(pool) = state.database.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "database_not_configured"})),
        )
            .into_response());
    };
    match current_user(headers, pool).await {
        Ok(Some(user)) => {
            if user.status == "timed_out" && user.timeout_until.unwrap_or(0) > now() {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(json!({"error": "Your account is timed out."})),
                )
                    .into_response());
            }
            Ok((pool.clone(), user))
        }
        Ok(None) => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({"error": "Sign in required."})),
        )
            .into_response()),
        Err(error) => {
            tracing::error!(%error, "account API session lookup failed");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            )
                .into_response())
        }
    }
}

#[derive(FromRow)]
struct ProfileRow {
    display_name: Option<String>,
    avatar_url: Option<String>,
    bio: Option<String>,
    status: Option<String>,
    pronouns: Option<String>,
    email: Option<String>,
    email_verified_at: Option<i64>,
    phone: Option<String>,
    phone_verified_at: Option<i64>,
}

async fn get_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };

    let profile = sqlx::query_as::<_, ProfileRow>(
        "SELECT display_name, avatar_url, bio, status, pronouns, email,
                email_verified_at, phone, phone_verified_at
         FROM user_profiles WHERE user_id = $1",
    )
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    let profile = match profile {
        Ok(profile) => profile,
        Err(error) => {
            tracing::error!(%error, "profile lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "profile_lookup_failed"}))).into_response();
        }
    };

    let settings = sqlx::query_scalar::<_, String>(
        "SELECT settings_json FROM user_preferences WHERE user_id = $1",
    )
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    let settings = match settings {
        Ok(Some(value)) => serde_json::from_str::<Value>(&value).unwrap_or_else(|_| json!({})),
        Ok(None) => json!({}),
        Err(error) => {
            tracing::error!(%error, "profile privacy settings lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "profile_lookup_failed"}))).into_response();
        }
    };
    let show_online = settings
        .pointer("/privacy/showOnlineStatus")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let last_seen = sqlx::query_scalar::<_, i64>(
        "SELECT last_seen_at FROM user_presence WHERE user_id = $1",
    )
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    let last_seen = match last_seen {
        Ok(value) => value.unwrap_or(0),
        Err(error) => {
            tracing::error!(%error, "presence lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "profile_lookup_failed"}))).into_response();
        }
    };

    let status = if show_online && last_seen >= now() - 45 {
        profile.as_ref().and_then(|row| row.status.clone()).unwrap_or_else(|| "online".to_owned())
    } else {
        "offline".to_owned()
    };
    let profile_json = match profile {
        Some(row) => json!({
            "display_name": row.display_name,
            "avatar_url": row.avatar_url,
            "bio": row.bio,
            "status": status,
            "pronouns": row.pronouns,
            "email": row.email,
            "email_verified_at": row.email_verified_at,
            "phone": row.phone,
            "phone_verified_at": row.phone_verified_at
        }),
        None => json!({
            "display_name": null,
            "avatar_url": null,
            "bio": null,
            "status": "offline",
            "pronouns": null,
            "email": null,
            "email_verified_at": null,
            "phone": null,
            "phone_verified_at": null
        }),
    };

    Json(json!({
        "profile": profile_json,
        "username": user.username,
        "account_type": user.account_type
    }))
    .into_response()
}

#[derive(Deserialize)]
struct UpdateProfileInput {
    display_name: Option<String>,
    avatar_url: Option<String>,
    bio: Option<String>,
    pronouns: Option<String>,
    status: Option<String>,
}

fn bounded(value: Option<String>, max_chars: usize) -> String {
    value
        .unwrap_or_default()
        .trim()
        .chars()
        .take(max_chars)
        .collect()
}

fn valid_avatar(value: &str) -> bool {
    if value.len() > 700_000 {
        return false;
    }
    if value.starts_with("https://") {
        return value.len() <= 1000 && !value.chars().any(char::is_whitespace);
    }
    let Some(encoded) = value.strip_prefix("data:image/jpeg;base64,") else {
        return false;
    };
    !encoded.is_empty()
        && encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
}

async fn update_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdateProfileInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let display_name = bounded(input.display_name, 32);
    let avatar_url = input.avatar_url.unwrap_or_default().trim().to_owned();
    let bio = bounded(input.bio, 190);
    let pronouns = bounded(input.pronouns, 32);
    let status = input
        .status
        .filter(|value| ["online", "idle", "dnd", "invisible"].contains(&value.as_str()))
        .unwrap_or_else(|| "online".to_owned());

    if !avatar_url.is_empty() && !valid_avatar(&avatar_url) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Avatar must be an HTTPS image URL or a cropped JPEG image under 500 KB."})),
        )
            .into_response();
    }

    let result = sqlx::query(
        "INSERT INTO user_profiles(user_id, display_name, avatar_url, bio, status, pronouns, updated_at)
         VALUES($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT(user_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            avatar_url = EXCLUDED.avatar_url,
            bio = EXCLUDED.bio,
            status = EXCLUDED.status,
            pronouns = EXCLUDED.pronouns,
            updated_at = EXCLUDED.updated_at",
    )
    .bind(&user.id)
    .bind(if display_name.is_empty() { None } else { Some(display_name.as_str()) })
    .bind(if avatar_url.is_empty() { None } else { Some(avatar_url.as_str()) })
    .bind(if bio.is_empty() { None } else { Some(bio.as_str()) })
    .bind(&status)
    .bind(if pronouns.is_empty() { None } else { Some(pronouns.as_str()) })
    .bind(now())
    .execute(&pool)
    .await;

    match result {
        Ok(_) => Json(json!({
            "ok": true,
            "display_name": if display_name.is_empty() { None } else { Some(display_name) },
            "avatar_url": if avatar_url.is_empty() { None } else { Some(avatar_url) }
        }))
        .into_response(),
        Err(error) => {
            tracing::error!(%error, "profile update failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "profile_update_failed"}))).into_response()
        }
    }
}

async fn presence_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let settings = sqlx::query_scalar::<_, String>(
        "SELECT settings_json FROM user_preferences WHERE user_id = $1",
    )
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    let settings = match settings {
        Ok(Some(value)) => serde_json::from_str::<Value>(&value).unwrap_or_else(|_| json!({})),
        Ok(None) => json!({}),
        Err(error) => {
            tracing::error!(%error, "presence privacy settings lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "presence_update_failed"}))).into_response();
        }
    };
    let show_online = settings
        .pointer("/privacy/showOnlineStatus")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let presence = if show_online { "online" } else { "offline" };
    let last_seen = if show_online { now() } else { 0 };
    let result = sqlx::query(
        "INSERT INTO user_presence(user_id, last_seen_at) VALUES($1, $2)
         ON CONFLICT(user_id) DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at",
    )
    .bind(&user.id)
    .bind(last_seen)
    .execute(&pool)
    .await;
    match result {
        Ok(_) => Json(json!({"ok": true, "presence": presence})).into_response(),
        Err(error) => {
            tracing::error!(%error, "presence heartbeat failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "presence_update_failed"}))).into_response()
        }
    }
}

async fn get_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let settings = sqlx::query_scalar::<_, String>(
        "SELECT settings_json FROM user_preferences WHERE user_id = $1",
    )
    .bind(&user.id)
    .fetch_optional(&pool)
    .await;
    match settings {
        Ok(Some(value)) => {
            let parsed = serde_json::from_str::<Value>(&value).unwrap_or_else(|_| json!({}));
            Json(json!({"settings": parsed})).into_response()
        }
        Ok(None) => Json(json!({"settings": {}})).into_response(),
        Err(error) => {
            tracing::error!(%error, "preferences lookup failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "preferences_lookup_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct UpdatePreferencesInput {
    settings: Value,
}

async fn update_preferences(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdatePreferencesInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    if !input.settings.is_object() {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid settings payload."}))).into_response();
    }
    let serialized = match serde_json::to_string(&input.settings) {
        Ok(value) if value.len() <= 65_000 => value,
        _ => return (StatusCode::BAD_REQUEST, Json(json!({"error": "Invalid settings payload."}))).into_response(),
    };
    let result = sqlx::query(
        "INSERT INTO user_preferences(user_id, settings_json, updated_at) VALUES($1, $2, $3)
         ON CONFLICT(user_id) DO UPDATE SET settings_json = EXCLUDED.settings_json, updated_at = EXCLUDED.updated_at",
    )
    .bind(&user.id)
    .bind(serialized)
    .bind(now())
    .execute(&pool)
    .await;
    match result {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(error) => {
            tracing::error!(%error, "preferences update failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "preferences_update_failed"}))).into_response()
        }
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/account/profile", get(get_profile).post(update_profile))
        .route("/api/account/preferences", get(get_preferences).post(update_preferences))
        .route("/api/presence/heartbeat", post(presence_heartbeat))
}
