# Neon database migration

MallowCord now uses Neon PostgreSQL as its primary and only application database. Cloudflare D1 remains bound temporarily as an emergency rollback resource, but application queries are routed to Neon by `MALLOWCORD_DB_BACKEND=neon`.

## Data reset

The D1 data is intentionally not copied. The owner approved starting fresh because no important data was stored there. Existing D1 users, sessions, servers, messages, and settings will not appear in Neon.

The first owner account is created through the configured owner Google or Discord OAuth identity (or the existing bootstrap flow). The Worker then creates the initial Mallow Swamp system server, default roles, and general channel as needed.

## Database coverage

The Neon database contains the application tables used by the Worker, including:

- Accounts, OAuth identities, sessions, profiles, preferences, recovery codes, presence, and bans
- Servers, channels, sections, roles, memberships, member roles, permissions, onboarding, and emojis
- Server messages, attachments, replies, reactions, forwards, notifications, and bot messages
- Friend requests, friendships, DM conversations, and DM messages
- Discord bridge links, command jobs, and outbox
- Audit logs, OAuth diagnostics, and Worker error logs

## Runtime compatibility

The Worker uses `worker/postgres-adapter.js` to preserve the D1-style `prepare().bind().first/all/run()` interface while translating positional placeholders and supported SQLite insert/JSON/aggregation syntax to PostgreSQL.

The D1 binding is intentionally retained during the first live verification window. Do not remove it until OAuth login, owner bootstrap, server creation, messaging, DMs, and Discord bridge operations have been tested against Neon.

## Rollback

To route application queries back to D1, set `MALLOWCORD_DB_BACKEND=d1` and `MALLOWCORD_NEON_FEATURES=` (empty), then deploy. This does not restore old D1 data; it only routes requests to the still-bound D1 database.

## Deployment

The GitHub Actions workflow runs adapter tests on pull requests. After this PR is merged, manually run the Worker deployment workflow from `main`. It uses Wrangler `--keep-vars` to preserve dashboard secrets. Verify the live Worker has its Neon Hyperdrive binding and `MALLOWCORD_DB_BACKEND=neon`.
