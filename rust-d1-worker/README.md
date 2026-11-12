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

Apply `migrations/0001_rust_discord_sync.sql` to the existing database before using
the sync endpoints. The migration is additive; it never drops or rewrites existing
application tables or records.

## No-change Discord snapshot behavior

The bridge's preload and change detector live in Mallow-Bot, not in D1. Mallow-Bot reads the already-maintained Discord gateway cache and fingerprints the guild structure, permissions, and stable member batches before it calls this Worker.

- Default recovery scan: every 300 seconds, configurable with `MALLOWCORD_SNAPSHOT_SCAN_SECONDS` on Mallow-Bot (minimum 60 seconds).
- Unchanged structure, permission, or member batches are skipped inside Mallow-Bot. No HTTP request reaches this Worker, so the scan performs zero D1 reads and zero D1 writes for those unchanged snapshots.
- Member presence is tracked separately and only changed statuses are sent through the presence batch path.
- Changed snapshots still reach the existing D1 sync handler. A Mallow-Bot restart clears the process-local fingerprints, so its first scan intentionally re-synchronizes data to recover from missed events.

This keeps the current D1 schema unchanged and avoids a fingerprint-table lookup on every scan. The preload is process-local to one Mallow-Bot instance; it is not a shared cache for browser sessions or multiple bot replicas. Other MallowCord API operations are unaffected and may still access their configured database.

