# MallowCord Rust backend

This is the provider-independent Rust service that will host performance-sensitive MallowCord backend work. It is designed to run on the Oracle VM initially, but it must remain portable to another Linux VPS or cloud provider.

## Current scope

The first milestone is intentionally non-invasive:

- Axum/Tokio HTTP service.
- `GET /health` health check.
- Structured request logging.
- Graceful shutdown.
- Configurable bind address through `MALLOWCORD_BIND_ADDR`.

The existing Cloudflare Worker remains the production API and continues to own authentication, browser sessions, and current application behavior. This Rust service does not replace or modify those paths yet.

## Planned integration

1. Add an authenticated server-to-server contract between the Worker/Mallow-Bot and this service.
2. Receive Discord member, presence, channel, role, permission, and moderation events from Mallow-Bot.
3. Process expensive work off the request path and expose validated results to the Worker.
4. Add upload-related processing where profiling shows a real CPU bottleneck; keep file storage provider-independent.
5. Add durable queueing, persistence, retry/idempotency, and observability before production event ingestion.

## Security and portability

- Never commit bot tokens, service keys, database URLs, or other secrets.
- Keep the Discord bot token in Mallow-Bot only.
- Authenticate every private service endpoint before accepting data.
- Do not expose this service directly to browsers.
- Keep Oracle-specific provisioning outside this application directory.
- Do not make the Rust service the source of truth for Discord permissions; calculate from synchronized Discord state and retain Discord as the authority.

## Local development

Install Rust stable, then:

```sh
cd rust-backend
cargo run
```

The service listens on `0.0.0.0:8081` by default. Check `http://127.0.0.1:8081/health`.

Run tests with:

```sh
cargo test
```

## Container

Build from the repository root:

```sh
docker build -f rust-backend/Dockerfile -t mallowcord-rust-backend .
```

Run with:

```sh
docker run --rm -p 8081:8081 mallowcord-rust-backend
```
