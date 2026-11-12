# MallowCord Rust backend

The Rust service is the destination for MallowCord's performance-sensitive API and real-time backend. It is provider-independent and can run on the planned Oracle VM or another Linux VPS without changing application code.

## Implemented in this branch

- Axum/Tokio HTTP service with graceful shutdown, request tracing, and configurable database readiness.
- Neon PostgreSQL connection pool and versioned SQLx migrations applied at startup.
- Google/Discord OAuth login-code exchange and device-session creation, plus existing device-cookie session lookup/logout, account status, profile, preferences, presence, username changes, and email/phone verification APIs.
- Server list, channel list, member/role views, sections, role assignment, settings, channel permission APIs, and custom emoji management with image validation and reaction cleanup.
- Message history, send/edit/delete, replies, reactions, forwards, attachment metadata, and S3-compatible attachment storage.
- Friends, friend requests, DMs, notifications, notification preferences, and privacy-aware public user profiles with server role visibility.
- Authenticated WebSocket delivery for channel and DM events; the browser now consumes live message, member/presence, and mention/reply notification events, with message/DM/member/notification polling retained only while the Rust socket is unavailable.
- Per-connection, short-lived channel/server visibility caching to avoid a PostgreSQL permission query for every broadcast event, with bounded cache growth.
- Optimized channel visibility and permission evaluation using batched PostgreSQL queries rather than per-channel query loops, plus additive indexes for sessions, memberships, message history, attachments, sections, and pending Discord outbox rows.
- Mallow-Bot integration APIs for guild snapshot sync, Discord presence, Discord message ingestion, account linking, command queue/results, and outgoing-message acknowledgements; the web Discord-link flow and `-mb` command submission now use Rust too. PostgreSQL migrations include the bridge channel-link/outbox schema and additional indexes for channel lookups and pending outgoing-message delivery.
- Mallow-Bot user listing and timeout/ban/unban/delete moderation endpoints.
- Owner-only audit log and global IP-ban creation/enforcement.
- Durable `event_inbox` table and `POST /internal/v1/events` for timestamped HMAC-SHA256 events, with body limits and idempotent event IDs.
- Optional Cloudflare Worker proxy with a method-specific route allowlist. It remains disabled until the Worker variable `RUST_API_ORIGIN` is configured.
- Container build and CI tests, including a syntax check for the browser application JavaScript.

## Environment

Copy `.env.example` and fill in secrets locally. Do not commit the populated file.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes for API routes | Neon PostgreSQL connection string |
| `MALLOWCORD_REQUIRE_DATABASE` | Production | Set to `true` to fail startup without Neon |
| `MALLOWCORD_BIND_ADDR` | No | Defaults to `0.0.0.0:8081` |
| `MALLOWCORD_ALLOWED_ORIGINS` | Browser realtime | Comma-separated allowed WebSocket origins |
| `MALLOWCORD_INTERNAL_EVENT_SECRET` | Event ingestion | HMAC secret; at least 32 random bytes |
| `MALLOWBOT_SERVICE_KEY` | Discord bridge | Same private service key used by Mallow-Bot and the Worker |
| `MALLOWCORD_DISCORD_GUILD_ID` | No | Official Discord guild ID; defaults to the current MallowCord guild |
| `MALLOWBOT_ICON_URL` | No | Public icon for Mallow-Bot command responses |
| `MALLOWCORD_PUBLIC_API_ORIGIN` | No | Public Worker origin used for data-URL avatar links in the Discord outbox |
| `IP_HASH_SECRET` | IP-ban enforcement and contact verification | Must exactly match the Worker secret used for existing hashes |
| `RESEND_API_KEY` | Email verification | Resend API key used to send account verification codes |
| `MALLOWCORD_EMAIL_FROM` | Email verification | Verified Resend sender address |
| `TWILIO_ACCOUNT_SID` | Phone verification | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Phone verification | Twilio API auth token |
| `TWILIO_FROM_NUMBER` | Phone verification | Twilio sender number in E.164 format |
| `MALLOWCORD_OBJECT_STORE_ENDPOINT` | Attachments | S3-compatible object storage endpoint |
| `MALLOWCORD_OBJECT_STORE_REGION` | Attachments | S3-compatible region; defaults to `auto` |
| `MALLOWCORD_OBJECT_STORE_BUCKET` | Attachments | Object storage bucket |
| `MALLOWCORD_OBJECT_STORE_ACCESS_KEY` | Attachments | Object storage access key |
| `MALLOWCORD_OBJECT_STORE_SECRET_KEY` | Attachments | Object storage secret key |
| `RUST_LOG` | No | Defaults to `info` |

The Rust origin must remain private behind the intended Cloudflare/Worker path. The Worker overwrites and forwards Cloudflare's client IP as `X-MallowCord-Client-IP`; do not expose the Rust listener directly to untrusted clients.

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
- Keep Discord bot credentials inside Mallow-Bot. Rust accepts the separate server-only Mallow-Bot service key and signed internal events, never the Discord bot token.
- Port one domain at a time and maintain API compatibility through the opt-in Worker proxy until the frontend is deliberately switched.
- Google/Discord OAuth provider redirects and callbacks and Worker error-log utilities remain on the Worker; OAuth login-code exchange and device-session creation now run in Rust.
- Do not set `RUST_API_ORIGIN` until the Rust host is deployed, migrations are applied, secrets are configured, and route-level testing is complete.
- Do not remove the Worker or D1 rollback binding until all routes and data paths have been verified.
