# MallowCord Rust + D1 Worker

This crate is the Rust/WASM Cloudflare Worker migration target. It binds directly to
the existing `mallowcord` D1 database (binding `DB`) and does not use Neon,
Hyperdrive, PostgreSQL, or SQLx.

## Current port

- `GET /health` and `GET /ready`
- Authenticated MallowBot Discord structure/member sync at
  `POST /api/integrations/mallowbot/discord/sync`
- Batched Discord message ingestion at
  `POST /api/integrations/mallowbot/discord/messages/batch`
- Idempotent Discord message-link records and bounded D1 batches.
- Bot-generated snapshot fingerprints for structure and stable member batches, allowing unchanged imports to return after one indexed D1 read.
- Conditional upserts for channels, roles, permissions, emojis, member profiles, and links so unchanged rows are not rewritten.
- No-op presence writes are suppressed; Mallow-Bot filters duplicate member/presence events before sending them.

The original Worker remains the production API until the remaining auth/OAuth,
account, permissions, server/channel, message/reaction/reply, friends/DM, upload,
moderation, and realtime routes have been ported and regression-tested.

## Build

Install Rust with `wasm32-unknown-unknown`, then install `worker-build`:

```sh
rustup target add wasm32-unknown-unknown
cargo install worker-build --locked
cd rust-d1-worker
worker-build --release
```

## Staging config

From the repository root:

```sh
npx wrangler deploy --config wrangler.rust.jsonc
```

Set `MALLOWBOT_SERVICE_KEY` as a Worker secret before accepting bot traffic:

```sh
npx wrangler secret put MALLOWBOT_SERVICE_KEY --config wrangler.rust.jsonc
```

The deployment is intentionally a separate staging Worker. It shares the existing D1
binding but does not replace `mallowcord-api` or modify production routing.

## D1 migration

Apply the additive migrations in order before deploying this branch:

1. `migrations/0001_rust_discord_sync.sql`
2. `migrations/0002_discord_sync_fingerprints.sql`

They create only the Discord bridge tables and sync-fingerprint table. They never drop
or rewrite existing application tables or records.
