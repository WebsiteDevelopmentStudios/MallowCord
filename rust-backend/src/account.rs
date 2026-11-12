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
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
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
            tracing::error!(%error, "account API session lookup failed");
            Err(Box::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "session_lookup_failed"})),
            )
                .into_response()))
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
        Err(response) => return *response,
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
        Err(response) => return *response,
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
        Err(response) => return *response,
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
        Err(response) => return *response,
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
        Err(response) => return *response,
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

#[derive(Deserialize)]
struct UpdateUsernameInput {
    username: String,
}

async fn update_username(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<UpdateUsernameInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let username = input.username.trim();
    let valid = (3..=24).contains(&username.len())
        && username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    if !valid {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Username must be 3–24 characters."})),
        )
            .into_response();
    }

    match sqlx::query(
        "UPDATE users SET username = $1, username_key = $2, updated_at = $3 WHERE id = $4",
    )
    .bind(username)
    .bind(username.to_ascii_lowercase())
    .bind(now())
    .bind(&user.id)
    .execute(&pool)
    .await
    {
        Ok(result) if result.rows_affected() == 1 => {
            Json(json!({"username": username})).into_response()
        }
        Ok(_) => (StatusCode::NOT_FOUND, Json(json!({"error": "Account not found."}))).into_response(),
        Err(error) if error.as_database_error().and_then(|db| db.code()).as_deref() == Some("23505") => {
            (StatusCode::CONFLICT, Json(json!({"error": "That username is already taken."}))).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "username update failed");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "username_update_failed"}))).into_response()
        }
    }
}

#[derive(Deserialize)]
struct ContactRequestInput {
    channel: String,
    value: String,
}

fn valid_contact_target(channel: &str, value: &str) -> bool {
    match channel {
        "email" => {
            let Some((local, domain)) = value.split_once('@') else {
                return false;
            };
            !local.is_empty()
                && !domain.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !value.chars().any(char::is_whitespace)
        }
        "phone" => {
            let digits = value.strip_prefix('+').unwrap_or_default();
            (8..=15).contains(&digits.len())
                && digits.chars().next().is_some_and(|character| character.is_ascii_digit() && character != '0')
                && digits.bytes().all(|byte| byte.is_ascii_digit())
        }
        _ => false,
    }
}

async fn delete_contact_code(pool: &PgPool, id: &str) {
    if let Err(error) = sqlx::query("DELETE FROM contact_verifications WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
    {
        tracing::error!(%error, "failed to clean up contact verification code");
    }
}

async fn request_contact_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ContactRequestInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let channel = input.channel.as_str();
    let target = input.value.trim();
    if !["email", "phone"].contains(&channel) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Choose email or phone verification."}))).into_response();
    }
    if !valid_contact_target(channel, target) {
        let error = if channel == "email" {
            "Enter a valid email address."
        } else {
            "Enter a phone number in international format, such as +12065550123."
        };
        return (StatusCode::BAD_REQUEST, Json(json!({"error": error}))).into_response();
    }
    if let Some(secret) = std::env::var("IP_HASH_SECRET").ok().filter(|value| !value.is_empty()) {
        let last = sqlx::query_scalar::<_, i64>(
            "SELECT created_at FROM contact_verifications
             WHERE user_id = $1 AND channel = $2",
        )
        .bind(&user.id)
        .bind(channel)
        .fetch_optional(&pool)
        .await;
        match last {
            Ok(Some(created_at)) if now() - created_at < 60 => {
                return (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error": "Please wait 60 seconds before requesting another code."}))).into_response();
            }
            Ok(_) => {}
            Err(error) => {
                tracing::error!(%error, "contact verification rate limit lookup failed");
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
            }
        }

        let random = Uuid::new_v4();
        let number = u32::from_be_bytes(random.as_bytes()[..4].try_into().unwrap()) % 1_000_000;
        let code = format!("{number:06}");
        let id = Uuid::new_v4().to_string();
        let code_hash = hex::encode(Sha256::digest(
            format!("{channel}:{}:{code}:{secret}", user.id).as_bytes(),
        ));
        let created_at = now();
        let expires_at = created_at + 600;
        let insert = sqlx::query(
            "INSERT INTO contact_verifications(id, user_id, channel, target, code_hash, expires_at, created_at)
             VALUES($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT(user_id, channel) DO UPDATE SET
                 id = EXCLUDED.id, target = EXCLUDED.target, code_hash = EXCLUDED.code_hash,
                 expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at",
        )
        .bind(&id)
        .bind(&user.id)
        .bind(channel)
        .bind(target)
        .bind(&code_hash)
        .bind(expires_at)
        .bind(created_at)
        .execute(&pool)
        .await;
        if let Err(error) = insert {
            tracing::error!(%error, "contact verification code insert failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
        }

        let client = reqwest::Client::new();
        let sent = if channel == "email" {
            let api_key = std::env::var("RESEND_API_KEY").ok().filter(|value| !value.is_empty());
            let from = std::env::var("MALLOWCORD_EMAIL_FROM").ok().filter(|value| !value.is_empty());
            let (Some(api_key), Some(from)) = (api_key, from) else {
                delete_contact_code(&pool, &id).await;
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Email verification is not configured yet. The site owner must configure the Resend email service and verified sender address."}))).into_response();
            };
            client
                .post("https://api.resend.com/emails")
                .bearer_auth(api_key)
                .json(&json!({
                    "from": from,
                    "to": [target],
                    "subject": "Your MallowCord verification code",
                    "text": format!("Your MallowCord verification code is {code}. It expires in 10 minutes. If you did not request this, ignore this email.")
                }))
                .send()
                .await
        } else {
            let account_sid = std::env::var("TWILIO_ACCOUNT_SID").ok().filter(|value| !value.is_empty());
            let auth_token = std::env::var("TWILIO_AUTH_TOKEN").ok().filter(|value| !value.is_empty());
            let from = std::env::var("TWILIO_FROM_NUMBER").ok().filter(|value| !value.is_empty());
            let (Some(account_sid), Some(auth_token), Some(from)) = (account_sid, auth_token, from) else {
                delete_contact_code(&pool, &id).await;
                return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Phone verification is not configured yet. The site owner must configure Twilio SMS."}))).into_response();
            };
            client
                .post(format!("https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"))
                .basic_auth(account_sid, Some(auth_token))
                .form(&[
                    ("To", target),
                    ("From", from.as_str()),
                    ("Body", format!("Your MallowCord verification code is {code}. It expires in 10 minutes.").as_str()),
                ])
                .send()
                .await
        };
        match sent {
            Ok(response) if response.status().is_success() => {}
            Ok(response) => {
                tracing::warn!(status = %response.status(), "contact verification provider rejected the request");
                delete_contact_code(&pool, &id).await;
                let error = if channel == "email" {
                    "The verification email could not be sent. Check the email service configuration."
                } else {
                    "The verification text could not be sent. Check the SMS service configuration."
                };
                return (StatusCode::BAD_GATEWAY, Json(json!({"error": error}))).into_response();
            }
            Err(error) => {
                tracing::error!(%error, "contact verification provider request failed");
                delete_contact_code(&pool, &id).await;
                let error = if channel == "email" {
                    "The verification email could not be sent. Check the email service configuration."
                } else {
                    "The verification text could not be sent. Check the SMS service configuration."
                };
                return (StatusCode::BAD_GATEWAY, Json(json!({"error": error}))).into_response();
            }
        }

        let profile = sqlx::query(
            "INSERT INTO user_profiles(user_id, updated_at) VALUES($1, $2)
             ON CONFLICT(user_id) DO NOTHING",
        )
        .bind(&user.id)
        .bind(now())
        .execute(&pool)
        .await;
        if let Err(error) = profile {
            tracing::error!(%error, "contact profile initialization failed");
            delete_contact_code(&pool, &id).await;
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
        }
        let update_sql = if channel == "email" {
            "UPDATE user_profiles SET email = $1, email_verified_at = NULL, updated_at = $2 WHERE user_id = $3"
        } else {
            "UPDATE user_profiles SET phone = $1, phone_verified_at = NULL, updated_at = $2 WHERE user_id = $3"
        };
        if let Err(error) = sqlx::query(update_sql)
            .bind(target)
            .bind(now())
            .bind(&user.id)
            .execute(&pool)
            .await
        {
            tracing::error!(%error, "contact profile update failed");
            delete_contact_code(&pool, &id).await;
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
        }
        return Json(json!({
            "ok": true,
            "message": "Verification code sent. It expires in 10 minutes."
        })).into_response();
    }
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Contact verification is not configured yet."}))).into_response()
}

#[derive(Deserialize)]
struct ContactConfirmInput {
    channel: String,
    code: String,
}

async fn confirm_contact_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<ContactConfirmInput>,
) -> Response {
    let (pool, user) = match require_user(&state, &headers).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let channel = input.channel.as_str();
    let code = input.code.trim();
    if !["email", "phone"].contains(&channel) || code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "Enter the six-digit verification code."}))).into_response();
    }
    let Some(secret) = std::env::var("IP_HASH_SECRET").ok().filter(|value| !value.is_empty()) else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "Contact verification is not configured yet."}))).into_response();
    };
    let row = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT id, code_hash, expires_at FROM contact_verifications
         WHERE user_id = $1 AND channel = $2",
    )
    .bind(&user.id)
    .bind(channel)
    .fetch_optional(&pool)
    .await;
    let (id, stored_hash, _expires_at) = match row {
        Ok(Some(value)) if value.2 >= now() => value,
        Ok(_) => return (StatusCode::BAD_REQUEST, Json(json!({"error": "That verification code is invalid or expired."}))).into_response(),
        Err(error) => {
            tracing::error!(%error, "contact verification code lookup failed");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
        }
    };
    let expected_hash = hex::encode(Sha256::digest(
        format!("{channel}:{}:{code}:{secret}", user.id).as_bytes(),
    ));
    if stored_hash.len() != expected_hash.len()
        || stored_hash.as_bytes().ct_eq(expected_hash.as_bytes()).unwrap_u8() != 1
    {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "That verification code is invalid or expired."}))).into_response();
    }

    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(error) => {
            tracing::error!(%error, "contact verification confirmation transaction failed to start");
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
        }
    };
    if let Err(error) = sqlx::query(
        "INSERT INTO user_profiles(user_id, updated_at) VALUES($1, $2)
         ON CONFLICT(user_id) DO NOTHING",
    )
    .bind(&user.id)
    .bind(now())
    .execute(&mut *tx)
    .await
    {
        tracing::error!(%error, "contact verification profile initialization failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
    }
    let update_sql = if channel == "email" {
        "UPDATE user_profiles SET email_verified_at = $1, updated_at = $1 WHERE user_id = $2"
    } else {
        "UPDATE user_profiles SET phone_verified_at = $1, updated_at = $1 WHERE user_id = $2"
    };
    if let Err(error) = sqlx::query(update_sql)
        .bind(now())
        .bind(&user.id)
        .execute(&mut *tx)
        .await
    {
        tracing::error!(%error, "contact verification profile confirmation failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
    }
    if let Err(error) = sqlx::query("DELETE FROM contact_verifications WHERE id = $1")
        .bind(&id)
        .execute(&mut *tx)
        .await
    {
        tracing::error!(%error, "contact verification code cleanup failed");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
    }
    if let Err(error) = tx.commit().await {
        tracing::error!(%error, "contact verification confirmation transaction failed to commit");
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "contact_verification_failed"}))).into_response();
    }
    Json(json!({"ok": true, "verified": true})).into_response()
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/username", post(update_username))
        .route("/api/account/contact/request", post(request_contact_verification))
        .route("/api/account/contact/confirm", post(confirm_contact_verification))
        .route("/api/account/profile", get(get_profile).post(update_profile))
        .route("/api/account/preferences", get(get_preferences).post(update_preferences))
        .route("/api/presence/heartbeat", post(presence_heartbeat))
}
