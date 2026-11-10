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
