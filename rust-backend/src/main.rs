use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderMap, StatusCode},
    middleware::{from_fn_with_state, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{env, net::SocketAddr, sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tower_http::{limit::RequestBodyLimitLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

mod account;
mod admin;
mod messages;
mod notifications;
mod oauth;
mod realtime;
mod auth;
mod discord_bridge;
mod server;
mod social;
mod storage;
mod uploads;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) database: Option<PgPool>,
    pub(crate) object_store: Option<Arc<dyn object_store::ObjectStore>>,
    pub(crate) realtime: tokio::sync::broadcast::Sender<Value>,
    internal_event_secret: Option<Arc<Vec<u8>>>,
    pub(crate) mallowbot_service_key: Option<Arc<Vec<u8>>>,
    pub(crate) discord_guild_id: Arc<String>,
    pub(crate) mallowbot_icon_url: Option<String>,
    pub(crate) ip_hash_secret: Option<Arc<Vec<u8>>>,
    pub(crate) public_api_origin: Arc<String>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

#[derive(Serialize)]
struct ReadyResponse {
    status: &'static str,
    database: &'static str,
}

#[derive(Serialize)]
struct EventAccepted {
    accepted: bool,
    duplicate: bool,
    event_id: String,
}

#[derive(Deserialize)]
struct EventEnvelope {
    source: String,
    event_type: String,
    payload: Value,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "mallowcord-rust-backend",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    let Some(pool) = state.database else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ReadyResponse { status: "not_ready", database: "not_configured" }),
        );
    };

    match sqlx::query("SELECT 1").execute(&pool).await {
        Ok(_) => (StatusCode::OK, Json(ReadyResponse { status: "ready", database: "connected" })),
        Err(error) => {
            tracing::error!(%error, "database readiness check failed");
            (StatusCode::SERVICE_UNAVAILABLE, Json(ReadyResponse { status: "not_ready", database: "unavailable" }))
        }
    }
}

async fn ingest_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> impl IntoResponse {
    let Some(secret) = state.internal_event_secret.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse { error: "internal_event_ingestion_not_configured" }),
        ).into_response();
    };

    let Some(pool) = state.database.as_ref() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ErrorResponse { error: "database_not_configured" }),
        ).into_response();
    };

    let timestamp = match headers.get("x-mallowcord-timestamp").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<i64>().ok()) {
        Some(value) => value,
        None => return (StatusCode::UNAUTHORIZED, Json(ErrorResponse { error: "invalid_signature_headers" })).into_response(),
    };
    let event_id = match headers.get("x-mallowcord-event-id").and_then(|v| v.to_str().ok()) {
        Some(value) if !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) => value.to_owned(),
        _ => return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: "invalid_event_id" })).into_response(),
    };
    let signature = match headers.get("x-mallowcord-signature").and_then(|v| v.to_str().ok()) {
        Some(value) => value.strip_prefix("sha256=").unwrap_or(value),
        None => return (StatusCode::UNAUTHORIZED, Json(ErrorResponse { error: "invalid_signature_headers" })).into_response(),
    };

    let now = chrono::Utc::now().timestamp();
    if timestamp.abs_diff(now) > 300 {
        return (StatusCode::UNAUTHORIZED, Json(ErrorResponse { error: "signature_expired" })).into_response();
    }

    let mut mac = match HmacSha256::new_from_slice(secret.as_slice()) {
        Ok(value) => value,
        Err(_) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: "signature_verification_failed" })).into_response(),
    };
    mac.update(timestamp.to_string().as_bytes());
    mac.update(b".");
    mac.update(event_id.as_bytes());
    mac.update(b".");
    mac.update(&body);

    let supplied = match hex::decode(signature) {
        Ok(value) => value,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(ErrorResponse { error: "invalid_signature" })).into_response(),
    };
    let expected = mac.finalize().into_bytes();
    if supplied.len() != expected.len() || supplied.as_slice().ct_eq(expected.as_slice()).unwrap_u8() != 1 {
        return (StatusCode::UNAUTHORIZED, Json(ErrorResponse { error: "invalid_signature" })).into_response();
    }

    let envelope: EventEnvelope = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: "invalid_event_json" })).into_response(),
    };
    if envelope.source.is_empty() || envelope.source.len() > 64 || envelope.event_type.is_empty() || envelope.event_type.len() > 128 {
        return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: "invalid_event_metadata" })).into_response();
    }

    let inserted = sqlx::query_scalar::<_, String>(
        "INSERT INTO event_inbox (event_id, source, event_type, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id"
    )
    .bind(&event_id)
    .bind(&envelope.source)
    .bind(&envelope.event_type)
    .bind(&envelope.payload)
    .fetch_optional(pool)
    .await;

    match inserted {
        Ok(value) => (
            StatusCode::ACCEPTED,
            Json(EventAccepted { accepted: true, duplicate: value.is_none(), event_id }),
        ).into_response(),
        Err(error) => {
            tracing::error!(%error, "failed to persist internal event");
            (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorResponse { error: "event_persistence_failed" })).into_response()
        }
    }
}


fn bounded_env_u32(name: &str, default: u32, minimum: u32, maximum: u32) -> u32 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(default)
        .clamp(minimum, maximum)
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let database = match env::var("DATABASE_URL") {
        Ok(url) if !url.trim().is_empty() => {
            let max_connections = bounded_env_u32("DATABASE_MAX_CONNECTIONS", 20, 1, 100);
            let min_connections =
                bounded_env_u32("DATABASE_MIN_CONNECTIONS", 1, 0, max_connections);
            let acquire_timeout =
                bounded_env_u32("DATABASE_ACQUIRE_TIMEOUT_SECS", 10, 1, 60);
            let idle_timeout = bounded_env_u32("DATABASE_IDLE_TIMEOUT_SECS", 300, 30, 3600);
            let max_lifetime =
                bounded_env_u32("DATABASE_MAX_LIFETIME_SECS", 1800, 60, 7200);
            let pool = PgPoolOptions::new()
                .max_connections(max_connections)
                .min_connections(min_connections)
                .acquire_timeout(Duration::from_secs(acquire_timeout.into()))
                .idle_timeout(Some(Duration::from_secs(idle_timeout.into())))
                .max_lifetime(Some(Duration::from_secs(max_lifetime.into())))
                .connect(&url)
                .await
                .expect("DATABASE_URL is set but PostgreSQL connection failed");
            sqlx::migrate!("./migrations")
                .run(&pool)
                .await
                .expect("database migrations failed");
            tracing::info!("PostgreSQL connected and migrations applied");
            Some(pool)
        }
        _ if env::var("MALLOWCORD_REQUIRE_DATABASE").as_deref() == Ok("true") => {
            panic!("DATABASE_URL is required when MALLOWCORD_REQUIRE_DATABASE=true");
        }
        _ => {
            tracing::warn!("DATABASE_URL is not configured; only /health will be ready");
            None
        }
    };

    let internal_event_secret = env::var("MALLOWCORD_INTERNAL_EVENT_SECRET")
        .ok()
        .filter(|value| value.len() >= 32)
        .map(|value| Arc::new(value.into_bytes()));

    let mallowbot_service_key = env::var("MALLOWBOT_SERVICE_KEY")
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| Arc::new(value.into_bytes()));
    let discord_guild_id = Arc::new(
        env::var("MALLOWCORD_DISCORD_GUILD_ID")
            .unwrap_or_else(|_| "1560367587542433812".to_owned()),
    );
    let mallowbot_icon_url = env::var("MALLOWBOT_ICON_URL").ok();
    let ip_hash_secret = env::var("IP_HASH_SECRET")
        .ok()
        .filter(|value| !value.is_empty())
        .map(|value| Arc::new(value.into_bytes()));
    let public_api_origin = Arc::new(
        env::var("MALLOWCORD_PUBLIC_API_ORIGIN")
            .unwrap_or_else(|_| "https://mallowcord-api.wowgrayhaha.workers.dev".to_owned()),
    );

    let object_store = storage::from_env();
    let (realtime, _) = tokio::sync::broadcast::channel(4096);
    let state = AppState {
        database,
        object_store,
        realtime,
        internal_event_secret,
        mallowbot_service_key,
        discord_guild_id,
        mallowbot_icon_url,
        ip_hash_secret,
        public_api_origin,
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .route("/internal/v1/events", post(ingest_event).layer(DefaultBodyLimit::max(256 * 1024)))
        .merge(auth::router())
        .merge(account::router())
        .merge(admin::router())
        .merge(discord_bridge::router())
        .merge(messages::router())
        .merge(notifications::router())
        .merge(oauth::router())
        .merge(realtime::router())
        .merge(uploads::router())
        .merge(server::router())
        .merge(social::router())
        .layer(from_fn_with_state(state.clone(), enforce_global_ip_ban))
        .with_state(state)
        .layer(RequestBodyLimitLayer::new(26 * 1024 * 1024))
        .layer(TraceLayer::new_for_http());

    let address: SocketAddr = env::var("MALLOWCORD_BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:8081".to_owned())
        .parse()
        .expect("MALLOWCORD_BIND_ADDR must be a valid socket address");
    let listener = tokio::net::TcpListener::bind(address).await.expect("failed to bind Rust backend listener");

    tracing::info!(%address, "MallowCord Rust backend listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("Rust backend server failed");
}

async fn enforce_global_ip_ban(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path();
    if path == "/health" || path == "/ready" {
        return next.run(request).await;
    }
    let Some(secret) = state.ip_hash_secret.as_ref() else {
        return next.run(request).await;
    };
    let ip = request
        .headers()
        .get("x-mallowcord-client-ip")
        .or_else(|| request.headers().get("cf-connecting-ip"))
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim();
    if ip.is_empty() || ip.parse::<std::net::IpAddr>().is_err() {
        return next.run(request).await;
    }

    let mut material = ip.as_bytes().to_vec();
    material.extend_from_slice(secret.as_slice());
    let ip_hash = hex::encode(Sha256::digest(material));
    let Some(pool) = state.database.as_ref() else {
        return next.run(request).await;
    };
    match sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
             SELECT 1 FROM bans
             WHERE ip_hash = $1 AND server_id IS NULL
               AND (expires_at IS NULL OR expires_at > $2)
         )",
    )
    .bind(ip_hash)
    .bind(chrono::Utc::now().timestamp())
    .fetch_one(pool)
    .await
    {
        Ok(true) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Access to MallowCord is blocked."})),
        )
            .into_response(),
        Ok(false) => next.run(request).await,
        Err(error) => {
            tracing::error!(%error, "global IP ban lookup failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({"error": "access_check_unavailable"})),
            )
                .into_response()
        }
    }
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    #[tokio::test]
    async fn health_endpoint_reports_service_status() {
        let app = Router::new().route("/health", get(health));
        let response = app.oneshot(Request::builder().uri("/health").body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed["status"], "ok");
        assert_eq!(parsed["service"], "mallowcord-rust-backend");
    }

    #[test]
    fn event_signature_uses_timestamp_event_id_and_raw_body() {
        let secret = b"a-test-secret-that-is-at-least-32-bytes";
        let timestamp = "1800000000";
        let event_id = "event-123";
        let body = br#"{"source":"mallowbot","event_type":"member.updated","payload":{}}"#;
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(timestamp.as_bytes());
        mac.update(b".");
        mac.update(event_id.as_bytes());
        mac.update(b".");
        mac.update(body);
        let signature = hex::encode(mac.finalize().into_bytes());
        assert_eq!(signature.len(), 64);
    }
}

#[cfg(test)]
mod pool_config_tests {
    use super::bounded_env_u32;

    #[test]
    fn pool_settings_use_defaults_for_missing_or_invalid_values() {
        assert_eq!(bounded_env_u32("UNUSED", 20, 1, 100), 20);
        assert_eq!(bounded_env_u32("UNUSED", 20, 1, 100), 20);
    }

    #[test]
    fn pool_settings_are_clamped_to_safe_bounds() {
        assert_eq!(bounded_env_u32("UNUSED", 20, 1, 10), 10);
        assert_eq!(bounded_env_u32("UNUSED", 1, 0, 20), 1);
    }
}
