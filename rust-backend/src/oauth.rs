use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Redirect, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::{collections::HashMap, env};
use uuid::Uuid;

use crate::AppState;

const DEFAULT_FRONTEND_ORIGIN: &str = "https://mallowcord-web.onrender.com";
const DEFAULT_PUBLIC_API_ORIGIN: &str = "https://mallowcord-api.wowgrayhaha.workers.dev";

#[derive(Clone, Copy)]
struct Provider {
    name: &'static str,
    authorization_url: &'static str,
    token_url: &'static str,
    profile_url: &'static str,
    client_id_env: &'static str,
    client_secret_env: &'static str,
    redirect_env: &'static str,
}

fn provider(name: &str) -> Option<Provider> {
    match name {
        "google" => Some(Provider {
            name: "google",
            authorization_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            profile_url: "https://openidconnect.googleapis.com/v1/userinfo",
            client_id_env: "GOOGLE_CLIENT_ID",
            client_secret_env: "GOOGLE_CLIENT_SECRET",
            redirect_env: "GOOGLE_REDIRECT_URI",
        }),
        "discord" => Some(Provider {
            name: "discord",
            authorization_url: "https://discord.com/oauth2/authorize",
            token_url: "https://discord.com/api/oauth2/token",
            profile_url: "https://discord.com/api/users/@me",
            client_id_env: "DISCORD_CLIENT_ID",
            client_secret_env: "DISCORD_CLIENT_SECRET",
            redirect_env: "DISCORD_REDIRECT_URI",
        }),
        _ => None,
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn sha256(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn redirect_uri(config: Provider) -> String {
    env::var(config.redirect_env).unwrap_or_else(|_| {
        let origin = env::var("MALLOWCORD_PUBLIC_API_ORIGIN")
            .unwrap_or_else(|_| DEFAULT_PUBLIC_API_ORIGIN.to_owned())
            .trim_end_matches('/')
            .to_owned();
        format!("{origin}/api/auth/{}/callback", config.name)
    })
}

fn frontend_origin() -> String {
    env::var("FRONTEND_ORIGIN").unwrap_or_else(|_| DEFAULT_FRONTEND_ORIGIN.to_owned())
}

fn failure_redirect(provider_name: &str) -> Response {
    let origin = frontend_origin();
    match reqwest::Url::parse(&origin) {
        Ok(mut target) if target.scheme() == "https" || target.host_str() == Some("localhost") => {
            target.set_path("/");
            target.set_query(None);
            target.set_fragment(None);
            target.query_pairs_mut().append_pair("login_error", provider_name);
            Redirect::temporary(target.as_str()).into_response()
        }
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "oauth_frontend_not_configured"})),
        )
            .into_response(),
    }
}

async fn diagnostic(pool: &PgPool, provider_name: &str, stage: &str, details: Value) {
    if let Err(error) = sqlx::query(
        "INSERT INTO oauth_diagnostics(id, provider, stage, detail, created_at)
         VALUES($1, $2, $3, $4, $5)",
    )
    .bind(Uuid::new_v4().to_string())
    .bind(provider_name)
    .bind(stage.chars().take(100).collect::<String>())
    .bind(details.to_string().chars().take(4000).collect::<String>())
    .bind(now())
    .execute(pool)
    .await
    {
        tracing::warn!(%error, provider = provider_name, stage, "OAuth diagnostic write failed");
    }
}

async fn start(
    State(state): State<AppState>,
    Path(provider_name): Path<String>,
) -> Response {
    let Some(config) = provider(&provider_name) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "oauth_provider_not_found"})))
            .into_response();
    };
    let Some(pool) = state.database.as_ref() else {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "database_not_configured"})))
            .into_response();
    };
    let client_id = match env::var(config.client_id_env) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "oauth_not_configured"}))).into_response(),
    };

    let state_token = random_token();
    let timestamp = now();
    if let Err(error) = sqlx::query("DELETE FROM oauth_states WHERE expires_at < $1")
        .bind(timestamp)
        .execute(pool)
        .await
    {
        tracing::error!(%error, provider = config.name, "OAuth state cleanup failed");
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "oauth_unavailable"}))).into_response();
    }
    if let Err(error) = sqlx::query(
        "INSERT INTO oauth_states(state_hash, provider, expires_at, created_at)
         VALUES($1, $2, $3, $4)",
    )
    .bind(sha256(&state_token))
    .bind(config.name)
    .bind(timestamp + 600)
    .bind(timestamp)
    .execute(pool)
    .await
    {
        tracing::error!(%error, provider = config.name, "OAuth state creation failed");
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "oauth_unavailable"}))).into_response();
    }

    let mut target = match reqwest::Url::parse(config.authorization_url) {
        Ok(value) => value,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": "oauth_configuration_invalid"}))).into_response(),
    };
    target.query_pairs_mut()
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect_uri(config))
        .append_pair("response_type", "code")
        .append_pair(
            "scope",
            if config.name == "google" { "openid email profile" } else { "identify email" },
        )
        .append_pair("state", &state_token);
    if config.name == "google" {
        target.query_pairs_mut().append_pair("prompt", "select_account");
    }
    Redirect::temporary(target.as_str()).into_response()
}

#[derive(FromRow)]
struct OAuthUser {
    id: String,
    username: String,
    account_type: String,
    status: String,
}

fn username_base(display_name: &str) -> String {
    let value: String = display_name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .take(18)
        .collect();
    if value.is_empty() { "MallowUser".to_owned() } else { value }
}

async fn ensure_system_membership(
    pool: &PgPool,
    user: &OAuthUser,
    icon_url: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut transaction = pool.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock(74198201)")
        .execute(&mut *transaction)
        .await?;

    let existing = sqlx::query_as::<_, (String, String)>(
        "SELECT id, owner_id FROM servers WHERE is_system = 1 ORDER BY created_at LIMIT 1",
    )
    .fetch_optional(&mut *transaction)
    .await?;

    let (server_id, server_owner) = if let Some(server) = existing {
        server
    } else {
        let server_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO servers(id, name, owner_id, icon_url, is_system, created_at)
             VALUES($1, 'Mallow Swamp', $2, $3, 1, $4)",
        )
        .bind(&server_id)
        .bind(&user.id)
        .bind(icon_url)
        .bind(now())
        .execute(&mut *transaction)
        .await?;

        let everyone_id = Uuid::new_v4().to_string();
        let member_id = Uuid::new_v4().to_string();
        let channel_id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO roles(id, server_id, name, is_system, position)
             VALUES($1, $2, '@everyone', 1, 0), ($3, $2, '@Member', 1, 1)",
        )
        .bind(everyone_id)
        .bind(&server_id)
        .bind(member_id)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "INSERT INTO channels(id, server_id, name, kind, position)
             VALUES($1, $2, 'general', 'text', 0)",
        )
        .bind(channel_id)
        .bind(&server_id)
        .execute(&mut *transaction)
        .await?;
        (server_id, user.id.clone())
    };

    if user.account_type == "owner" && server_owner != user.id {
        sqlx::query("UPDATE servers SET owner_id = $1 WHERE id = $2")
            .bind(&user.id)
            .bind(&server_id)
            .execute(&mut *transaction)
            .await?;
    }

    sqlx::query(
        "INSERT INTO memberships(server_id, user_id, joined_at)
         VALUES($1, $2, $3) ON CONFLICT(server_id, user_id) DO NOTHING",
    )
    .bind(&server_id)
    .bind(&user.id)
    .bind(now())
    .execute(&mut *transaction)
    .await?;

    let role_ids = sqlx::query_scalar::<_, String>(
        "SELECT id FROM roles WHERE server_id = $1 AND name IN ('@everyone', '@Member')",
    )
    .bind(&server_id)
    .fetch_all(&mut *transaction)
    .await?;
    for role_id in role_ids {
        sqlx::query(
            "INSERT INTO member_roles(server_id, user_id, role_id)
             VALUES($1, $2, $3) ON CONFLICT DO NOTHING",
        )
        .bind(&server_id)
        .bind(&user.id)
        .bind(role_id)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await
}

async fn provision_user(
    pool: &PgPool,
    config: Provider,
    profile: &Value,
    icon_url: Option<&str>,
) -> Result<OAuthUser, String> {
    let provider_id = profile
        .get(if config.name == "google" { "sub" } else { "id" })
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "identity_provider_user_id_missing".to_owned())?
        .to_owned();
    let email = profile
        .get("email")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let email_verified = config.name == "google"
        && profile.get("email_verified").and_then(Value::as_bool) == Some(true);

    let owner_match = if config.name == "google" {
        email_verified
            && env::var("OWNER_GOOGLE_EMAIL")
                .ok()
                .is_some_and(|owner| email.as_deref().is_some_and(|value| value.eq_ignore_ascii_case(owner.trim())))
    } else {
        env::var("OWNER_DISCORD_ID")
            .ok()
            .is_some_and(|owner| owner.trim() == provider_id)
    };

    let linked = sqlx::query_as::<_, OAuthUser>(
        "SELECT u.id, u.username, u.account_type, u.status
         FROM oauth_accounts a JOIN users u ON u.id = a.user_id
         WHERE a.provider = $1 AND a.provider_user_id = $2 LIMIT 1",
    )
    .bind(config.name)
    .bind(&provider_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| "oauth_account_lookup_failed".to_owned())?;

    let mut user = match linked {
        Some(user) => Some(user),
        None if owner_match => sqlx::query_as::<_, OAuthUser>(
            "SELECT id, username, account_type, status FROM users
             WHERE account_type = 'owner' ORDER BY created_at LIMIT 1",
        )
        .fetch_optional(pool)
        .await
        .map_err(|_| "owner_account_lookup_failed".to_owned())?,
        None => None,
    };

    if user.as_ref().is_some_and(|value| value.status != "active") {
        return Err("account_not_active".to_owned());
    }

    if user.is_none() {
        let display = profile
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| profile.get("global_name").and_then(Value::as_str))
            .or_else(|| profile.get("username").and_then(Value::as_str))
            .or_else(|| email.as_deref().and_then(|value| value.split('@').next()))
            .unwrap_or("MallowUser")
            .trim();
        let base = username_base(display);
        for attempt in 0..12 {
            let username = if attempt == 0 {
                base.clone()
            } else {
                let prefix: String = base.chars().take(13).collect();
                format!("{}_{}", prefix, &Uuid::new_v4().simple().to_string()[..4])
            };
            let id = Uuid::new_v4().to_string();
            let created = sqlx::query_as::<_, OAuthUser>(
                "INSERT INTO users(id, username, username_key, account_type, status, created_at, updated_at)
                 VALUES($1, $2, $3, $4, 'active', $5, $5)
                 ON CONFLICT(username_key) DO NOTHING
                 RETURNING id, username, account_type, status",
            )
            .bind(&id)
            .bind(&username)
            .bind(username.to_lowercase())
            .bind(if owner_match { "owner" } else { "basic" })
            .bind(now())
            .fetch_optional(pool)
            .await
            .map_err(|_| "account_creation_failed".to_owned())?;
            if created.is_some() {
                user = created;
                break;
            }
        }
    }

    let mut user = user.ok_or_else(|| "username_creation_failed".to_owned())?;
    if owner_match && user.account_type != "owner" {
        sqlx::query("UPDATE users SET account_type = 'owner', updated_at = $1 WHERE id = $2")
            .bind(now())
            .bind(&user.id)
            .execute(pool)
            .await
            .map_err(|_| "owner_role_update_failed".to_owned())?;
        user.account_type = "owner".to_owned();
    }

    sqlx::query(
        "INSERT INTO oauth_accounts(provider, provider_user_id, user_id, email, created_at, updated_at)
         VALUES($1, $2, $3, $4, $5, $5)
         ON CONFLICT(provider, provider_user_id) DO UPDATE
         SET email = EXCLUDED.email, updated_at = EXCLUDED.updated_at",
    )
    .bind(config.name)
    .bind(&provider_id)
    .bind(&user.id)
    .bind(email.as_deref())
    .bind(now())
    .execute(pool)
    .await
    .map_err(|_| "oauth_account_link_failed".to_owned())?;

    let display_name = profile
        .get("name")
        .and_then(Value::as_str)
        .or_else(|| profile.get("global_name").and_then(Value::as_str))
        .or_else(|| profile.get("username").and_then(Value::as_str))
        .unwrap_or(&user.username)
        .trim();
    let avatar_url = if config.name == "discord" {
        match profile.get("avatar").and_then(Value::as_str) {
            Some(hash) if !hash.is_empty() => {
                let extension = if hash.starts_with("a_") { "gif" } else { "png" };
                Some(format!("https://cdn.discordapp.com/avatars/{provider_id}/{hash}.{extension}?size=128"))
            }
            _ => None,
        }
    } else {
        profile
            .get("picture")
            .and_then(Value::as_str)
            .filter(|value| value.starts_with("https://") && value.len() <= 1000)
            .map(str::to_owned)
    };
    let email_verified_at = if email_verified { Some(now()) } else { None };

    sqlx::query(
        "INSERT INTO user_profiles(user_id, display_name, avatar_url, email, email_verified_at, updated_at)
         VALUES($1, $2, $3, $4, $5, $6)
         ON CONFLICT(user_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           avatar_url = COALESCE(EXCLUDED.avatar_url, user_profiles.avatar_url),
           email = COALESCE(EXCLUDED.email, user_profiles.email),
           email_verified_at = COALESCE(EXCLUDED.email_verified_at, user_profiles.email_verified_at),
           updated_at = EXCLUDED.updated_at",
    )
    .bind(&user.id)
    .bind(display_name.chars().take(64).collect::<String>())
    .bind(avatar_url)
    .bind(email.as_deref())
    .bind(email_verified_at)
    .bind(now())
    .execute(pool)
    .await
    .map_err(|_| "profile_update_failed".to_owned())?;

    ensure_system_membership(pool, &user, icon_url)
        .await
        .map_err(|_| "system_membership_failed".to_owned())?;

    Ok(user)
}

async fn callback(
    State(state): State<AppState>,
    Path(provider_name): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(config) = provider(&provider_name) else {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "oauth_provider_not_found"})))
            .into_response();
    };
    let Some(pool) = state.database.as_ref() else {
        return failure_redirect(config.name);
    };

    if query.contains_key("error") {
        diagnostic(pool, config.name, "provider_rejected", json!({"error": query.get("error")})).await;
        return failure_redirect(config.name);
    }
    let state_token = match query.get("state").filter(|value| !value.is_empty() && value.len() <= 256) {
        Some(value) => value,
        None => {
            diagnostic(pool, config.name, "state_missing", json!({})).await;
            return failure_redirect(config.name);
        }
    };
    let code = match query.get("code").filter(|value| !value.is_empty() && value.len() <= 4096) {
        Some(value) => value,
        None => {
            diagnostic(pool, config.name, "code_missing", json!({})).await;
            return failure_redirect(config.name);
        }
    };

    let saved = sqlx::query_as::<_, (String, i64)>(
        "DELETE FROM oauth_states WHERE state_hash = $1 RETURNING provider, expires_at",
    )
    .bind(sha256(state_token))
    .fetch_optional(pool)
    .await;
    let (saved_provider, expires_at) = match saved {
        Ok(Some(value)) => value,
        Ok(None) => {
            diagnostic(pool, config.name, "state_not_found", json!({})).await;
            return failure_redirect(config.name);
        }
        Err(error) => {
            tracing::error!(%error, provider = config.name, "OAuth state lookup failed");
            return failure_redirect(config.name);
        }
    };
    if saved_provider != config.name || expires_at < now() {
        diagnostic(pool, config.name, "state_invalid_or_expired", json!({"provider_matches": saved_provider == config.name})).await;
        return failure_redirect(config.name);
    }

    let client_id = match env::var(config.client_id_env) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            diagnostic(pool, config.name, "client_id_missing", json!({})).await;
            return failure_redirect(config.name);
        }
    };
    let client_secret = match env::var(config.client_secret_env) {
        Ok(value) if !value.trim().is_empty() => value,
        _ => {
            diagnostic(pool, config.name, "client_secret_missing", json!({})).await;
            return failure_redirect(config.name);
        }
    };

    let client = reqwest::Client::new();
    let callback_uri = redirect_uri(config);
    let token_response = client
        .post(config.token_url)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", callback_uri.as_str()),
        ])
        .send()
        .await;
    let token_response = match token_response {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, provider = config.name, "OAuth token request failed");
            diagnostic(pool, config.name, "token_request_failed", json!({})).await;
            return failure_redirect(config.name);
        }
    };
    if !token_response.status().is_success() {
        let status = token_response.status().as_u16();
        tracing::warn!(provider = config.name, status, "OAuth token endpoint rejected the code");
        diagnostic(pool, config.name, "token_exchange_rejected", json!({"status": status})).await;
        return failure_redirect(config.name);
    }
    let token_data: Value = match token_response.json().await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, provider = config.name, "OAuth token response was invalid JSON");
            return failure_redirect(config.name);
        }
    };
    let access_token = match token_data.get("access_token").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value,
        _ => {
            diagnostic(pool, config.name, "access_token_missing", json!({})).await;
            return failure_redirect(config.name);
        }
    };

    let profile_response = client
        .get(config.profile_url)
        .bearer_auth(access_token)
        .send()
        .await;
    let profile_response = match profile_response {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            diagnostic(pool, config.name, "profile_request_rejected", json!({"status": response.status().as_u16()})).await;
            return failure_redirect(config.name);
        }
        Err(error) => {
            tracing::error!(%error, provider = config.name, "OAuth profile request failed");
            return failure_redirect(config.name);
        }
    };
    let profile: Value = match profile_response.json().await {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, provider = config.name, "OAuth profile response was invalid JSON");
            return failure_redirect(config.name);
        }
    };
    if config.name == "google"
        && profile.get("email_verified").and_then(Value::as_bool) != Some(true)
    {
        diagnostic(pool, config.name, "email_not_verified", json!({})).await;
        return failure_redirect(config.name);
    }

    let user = match provision_user(
        pool,
        config,
        &profile,
        state.mallowbot_icon_url.as_deref(),
    )
    .await
    {
        Ok(user) => user,
        Err(reason) => {
            tracing::warn!(provider = config.name, %reason, "OAuth account provisioning failed");
            diagnostic(pool, config.name, "account_provisioning_failed", json!({"reason": reason})).await;
            return failure_redirect(config.name);
        }
    };

    let login_code = random_token();
    let timestamp = now();
    if let Err(error) = sqlx::query(
        "INSERT INTO oauth_login_codes(code_hash, user_id, expires_at, created_at)
         VALUES($1, $2, $3, $4)",
    )
    .bind(sha256(&login_code))
    .bind(&user.id)
    .bind(timestamp + 90)
    .bind(timestamp)
    .execute(pool)
    .await
    {
        tracing::error!(%error, provider = config.name, "OAuth login code creation failed");
        return failure_redirect(config.name);
    }

    let mut target = match reqwest::Url::parse(&frontend_origin()) {
        Ok(value) => value,
        Err(_) => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error": "oauth_frontend_not_configured"}))).into_response(),
    };
    target.set_path("/");
    target.set_query(None);
    target.set_fragment(None);
    target.query_pairs_mut().append_pair("oauth_code", &login_code);
    Redirect::temporary(target.as_str()).into_response()
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/{provider}", get(start))
        .route("/api/auth/{provider}/callback", get(callback))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_google_and_discord_are_supported() {
        assert_eq!(provider("google").unwrap().name, "google");
        assert_eq!(provider("discord").unwrap().name, "discord");
        assert!(provider("github").is_none());
    }

    #[test]
    fn generated_usernames_are_ascii_and_bounded() {
        assert_eq!(username_base("  Mallow User!  "), "MallowUser");
        assert_eq!(username_base("!!!"), "MallowUser");
        assert!(username_base("abcdefghijklmnopqrstuvwxyz").len() <= 18);
    }

    #[test]
    fn callback_uris_keep_the_worker_redirect_by_default() {
        let google = provider("google").unwrap();
        assert_eq!(
            redirect_uri(google),
            "https://mallowcord-api.wowgrayhaha.workers.dev/api/auth/google/callback"
        );
    }
}
