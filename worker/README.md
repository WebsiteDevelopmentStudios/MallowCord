# Worker API

The Cloudflare Worker is the same-origin API. Render serves public/; Cloudflare routes the custom hostname through this Worker, which proxies non-API paths to the Render origin configured in FRONTEND_ORIGIN.

## D1
Create a D1 database, apply schema.sql, and bind it to the Worker as DB.

## Required Worker variables/secrets
FRONTEND_ORIGIN, BOOTSTRAP_SECRET (one-time), OWNER_USERNAME (Blemmished), OWNER_PASSWORD, IP_HASH_SECRET, MALLOWBOT_SERVICE_KEY, MALLOWBOT_ICON_URL and ENVIRONMENT.

## Authentication
Basic users have no password. Registration creates a random session token in an HttpOnly, Secure, SameSite=Lax cookie; only its SHA-256 hash is stored in D1. A recovery code is displayed once. Recovery revokes previous sessions and issues a new code. Full-access accounts use PBKDF2 password hashes.

## Mallow-Bot integration
Server-to-server endpoints under /api/integrations/mallowbot/ require X-MallowBot-Key. Keep this key only in Render environment variables and Worker secrets. Supported actions: list users, create full-access users, timeout, ban, unban and delete.

This is an initial foundation. Configure Cloudflare rate limiting and test all authorization paths before public release. The chat client currently polls every five seconds; use Durable Objects/WebSockets for production realtime delivery.

## PostgreSQL / Neon migration (prepared, not activated)

The Worker now includes a D1-compatible query adapter backed by the Cloudflare Hyperdrive binding `NEON`.
Install dependencies with `npm install` before using Wrangler so the `postgres` package is bundled.

To test against Neon without changing production traffic, set the Worker variable
`MALLOWCORD_DB_BACKEND=neon` in a non-production environment first. The production
Worker intentionally remains on D1 until the owner explicitly approves the switch.

Keep the existing D1 binding during the migration as a rollback path. The Hyperdrive
binding is configured separately as `NEON`. The adapter preserves the existing
`.prepare().bind().first()/all()/run()` call pattern and `.batch()` interface,
converts positional placeholders, and translates the SQLite constructs currently used
by the application. Review/test every endpoint on a staging Worker before enabling Neon
in production.
