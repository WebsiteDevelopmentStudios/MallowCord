# MallowCord Rust backend

The Rust service is the destination for MallowCord's performance-sensitive API and real-time backend. It is provider-independent and can run on the planned Oracle VM or another Linux VPS without changing application code.

## Implemented in this branch

- Axum/Tokio HTTP service with graceful shutdown and structured request logs.
- Liveness endpoint: `GET /health`.
- Database readiness endpoint: `GET /ready`.
- Existing device-cookie session lookup and logout compatibility routes.
- Account status and owner-only audit log APIs.
- Neon PostgreSQL connection pool using `DATABASE_URL`.
- Versioned SQLx migrations, applied at startup.
- Durable `event_inbox` table for authenticated internal events.
- `POST /internal/v1/events` validates a timestamped HMAC-SHA256 signature, limits request bodies to 256 KiB, and persists events idempotently.
- Duplicate event IDs are acknowledged without inserting duplicate rows.
- Container build and CI tests.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | For DB features | Neon PostgreSQL connection string |
| `MALLOWCORD_INTERNAL_EVENT_SECRET` | For event ingestion | Shared HMAC secret; use at least 32 random bytes |
| `MALLOWCORD_BIND_ADDR` | No | Defaults to `0.0.0.0:8081` |
| `MALLOWCORD_REQUIRE_DATABASE` | No | Set to `true` to fail startup when DATABASE_URL is missing |
| `RUST_LOG` | No | Defaults to `info` |

Do not put secrets in Git, frontend environment variables, or public issue comments.

## Internal event signature contract

The sender serializes the JSON body once and signs these exact bytes:

```text
HMAC-SHA256(secret, timestamp + "." + event_id + "." + raw_body)
```

Send these headers:

- `X-MallowCord-Timestamp`: Unix timestamp in seconds (must be within five minutes).
- `X-MallowCord-Event-Id`: unique stable ID, up to 128 ASCII letters, digits, dots, underscores, or hyphens.
- `X-MallowCord-Signature`: lowercase hex digest, optionally prefixed with `sha256=`.

Body format:

```json
{
  "source": "mallowbot",
  "event_type": "discord.member.updated",
  "payload": {
    "discord_user_id": "123456789012345678"
  }
}
```

The event is stored in `event_inbox`; this endpoint does not yet claim that downstream business logic has completed. Event consumers and feature-specific handlers are a subsequent migration step.

## Run locally

Install stable Rust, then:

```sh
cd rust-backend
DATABASE_URL="postgres://..." cargo run
```

Check `http://127.0.0.1:8081/health` and `/ready`.

Run checks:

```sh
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
```

## Container

Build from the repository root:

```sh
docker build -f rust-backend/Dockerfile -t mallowcord-rust-backend .
```

Run with secrets supplied at runtime:

```sh
docker run --rm -p 8081:8081 \
  -e DATABASE_URL="$DATABASE_URL" \
  -e MALLOWCORD_INTERNAL_EVENT_SECRET="$MALLOWCORD_INTERNAL_EVENT_SECRET" \
  -e MALLOWCORD_REQUIRE_DATABASE=true \
  mallowcord-rust-backend
```

## Migration rules

- Keep the current Worker and frontend live until each Rust replacement is tested.
- Keep Neon PostgreSQL as the source of truth; Rust must not introduce a second database.
- Preserve current OAuth identities, device sessions, account IDs, server IDs, channels, roles, messages, friends, DMs, and attachments.
- Keep browser cookies and OAuth secrets server-side. The browser must not call privileged internal endpoints.
- Keep Discord bot credentials inside Mallow-Bot. Rust accepts signed service events, not bot tokens.
- Port one domain at a time and maintain API compatibility until the frontend is deliberately switched.
- Do not remove the Worker or D1 rollback binding until all routes and data paths have been verified.
