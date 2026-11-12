# MallowCord

Discord-inspired community chat for Mallow Swamp.

## Current architecture

- Render Static Site hosts the existing browser application in `public/`.
- Cloudflare Worker currently provides the production browser API, OAuth callbacks, device-cookie sessions, and compatibility with the current frontend.
- Neon PostgreSQL is the primary application database, accessed by the Worker through Cloudflare Hyperdrive.
- Cloudflare D1 remains bound temporarily as a rollback resource; it is not the current primary database.
- Mallow-Bot remains the Discord Gateway bot and retains its Discord bot token.
- The Rust/Axum service is being built as the long-term application backend. It connects directly to the same Neon database and is designed to run on an Oracle VM or another portable Linux host.

## Rust migration status

The `feature/rust-api-migration` branch introduces:

- Rust/Axum/Tokio service and container build.
- Neon PostgreSQL pool and versioned SQLx migrations.
- Liveness and database-readiness endpoints.
- Authenticated, timestamped HMAC event ingestion from trusted services.
- Durable, idempotent event inbox for Discord and backend events.
- Compatibility API routes for existing device-cookie session lookup, profile edits, preferences, presence, friends, friend requests, DMs, and DM messages.
- Server, channel, role, member, permission-filtered channel listing, message history, message send/edit/delete, reactions, replies, forwarding, mention notifications, and Discord outbox routes.
- Python event sender for Mallow-Bot integration.

This is an incremental migration. The existing Worker remains live and continues serving the frontend while routes and business logic are ported and tested in Rust. The new event endpoint acknowledges durable storage; it does not yet claim that all event handlers have run.

## Existing application capabilities

- Google and Discord OAuth sign-in with provider identities stored server-side.
- Generated unique usernames and secure HttpOnly device sessions.
- Owner privileges tied to the configured verified Google identity or Discord account.
- Automatic Mallow Swamp membership.
- Servers, channels, roles, permissions, messages, friends, DMs, and Discord bridge foundations.
- Owner moderation API primitives.

## Migration priorities

1. Move Discord member, presence, channel, role, and permission synchronization into Rust-backed durable processing.
2. Port core account, profile, server, channel, membership, role, permission, message, reaction, reply, friend, and DM API domains while preserving existing IDs and Neon data.
3. Replace five-second message polling with authenticated WebSocket real-time delivery.
4. Port attachment metadata, upload validation, image processing, and GIF-safe delivery without tying object storage to Oracle.
5. Add background jobs, retries, rate limits, metrics, tracing, and backup/restore verification.
6. Switch the frontend API only after route parity and regression tests pass.

## Safety rules

- Do not deploy an incomplete Rust API as the production browser API.
- Do not delete the Worker, current OAuth flow, existing Neon data, or rollback configuration during the migration.
- Never commit OAuth secrets, database URLs, bot tokens, or service keys.
- Keep Discord bot credentials in Mallow-Bot only.
- Keep object storage portable so moving away from Oracle does not require rewriting upload logic.

See `DEPLOYMENT.md`, `NEON-MIGRATION.md`, and `rust-backend/README.md`.
