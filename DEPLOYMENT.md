# Render + Cloudflare deployment

## Render frontend
1. Create a Render Static Site connected to WebsiteDevelopmentStudios/MallowCord.
2. Build command: echo "Static frontend ready".
3. Publish directory: public.
4. Save the Render origin URL, for example https://mallowcord-web.onrender.com.

## Cloudflare D1 and Worker
1. Create a D1 database named mallowcord.
2. Apply worker/schema.sql.
3. Create a Worker from worker/worker.js and bind the D1 database as DB.
4. Configure Worker variables/secrets:
   - FRONTEND_ORIGIN = Render Static Site URL (no trailing slash)
   - OWNER_USERNAME = Blemmished
   - BOOTSTRAP_SECRET = one-time random secret
   - OWNER_PASSWORD = strong owner password (minimum 12 characters)
   - IP_HASH_SECRET = independent random secret for hashing client IPs
   - MALLOWBOT_SERVICE_KEY = independent random service-to-service secret
   - MALLOWBOT_ICON_URL = Mallow-Bot icon URL
   - ENVIRONMENT = production
5. Attach a Cloudflare-managed hostname to the Worker and route all paths (/*) through it. The Worker handles /api/* and proxies website assets to Render.
6. Keep the public custom hostname on the Worker so cookies remain same-origin.

## Initialize owner and Mallow Swamp
After applying D1 and setting secrets, POST to https://YOUR-DOMAIN/api/bootstrap with JSON {"secret":"YOUR_BOOTSTRAP_SECRET"}. This creates Blemmished and the Mallow Swamp system server with @everyone, @Member and #general. Confirm the response, then rotate/remove BOOTSTRAP_SECRET.

## Render Mallow-Bot integration
On the Render service running Mallow-Bot, set MALLOWCORD_API_URL=https://YOUR-DOMAIN/api and MALLOWCORD_SERVICE_KEY to the same value as the Worker secret. Install the companion Mallow-Bot bridge. The key must remain server-side.

## Cloudflare security
- Add rate limits for registration, login, recovery, message posting and bootstrap.
- Enable managed WAF protections and HTTPS-only redirects.
- Keep browser traffic same-origin through the Worker.
- Do not trust client-provided IP headers; the Worker uses Cloudflare CF-Connecting-IP metadata.

## Pre-launch checklist
- Verify owner bootstrap and recovery in a test database.
- Test case-insensitive username collisions.
- Test recovery-code one-time use, rotation and session revocation.
- Confirm IP bans block registration and login as well as authenticated API routes.
- Add server invites/discovery, server-level bans, role assignment and permission checks.
- Add pagination, spam controls, reporting and moderation UI.
- Add Durable Objects/WebSockets before expecting Discord-like realtime behavior.


## Rust backend rollout (staged; not yet the browser API)

The Rust service is intentionally separate from the live Cloudflare Worker during migration. Do not point the frontend at it yet.

### Required runtime configuration

Set these as server-side environment variables on the Rust host:

- `DATABASE_URL`: Neon PostgreSQL connection string for the existing MallowCord database.
- `MALLOWCORD_INTERNAL_EVENT_SECRET`: a new random secret with at least 32 bytes.
- `MALLOWCORD_REQUIRE_DATABASE=true`.
- `MALLOWCORD_BIND_ADDR=0.0.0.0:8081`.
- `RUST_LOG=info`.
- `MALLOWCORD_OBJECT_STORE_ENDPOINT`, `MALLOWCORD_OBJECT_STORE_REGION`, `MALLOWCORD_OBJECT_STORE_BUCKET`, `MALLOWCORD_OBJECT_STORE_ACCESS_KEY`, and `MALLOWCORD_OBJECT_STORE_SECRET_KEY` for S3-compatible attachment storage.

Do not reuse the Cloudflare Worker service key as the HMAC secret. Do not put any of these values in GitHub, the browser, or the Render static site.

### Build and health checks

Build the container from the repository root:

```sh
docker build -f rust-backend/Dockerfile -t mallowcord-rust-backend .
```

Run it with the environment variables above and expose port 8081 only behind a firewall or private reverse proxy. Verify:

- `GET /health` returns liveness.
- `GET /ready` returns HTTP 200 only when Neon is reachable and migrations have completed.
- `POST /internal/v1/events` rejects missing, expired, or invalid signatures.
- Repeated event IDs do not create duplicate inbox rows.

The SQLx migrations add Rust runtime tables and indexes while retaining existing application identifiers. Review the migration files before production startup; they also relax the message content check to support attachment-only messages. They do not reset existing users, OAuth identities, servers, channels, messages, friends, or DMs.

### Mallow-Bot event sender

On the Mallow-Bot host, configure:

- `MALLOWCORD_RUST_API_URL`: private URL of the Rust service.
- `MALLOWCORD_INTERNAL_EVENT_SECRET`: the same secret configured on Rust.

Use `mallowbot-integration/rust_events.py` to send events. Supply the same event ID when retrying an event so the Rust inbox can deduplicate it. Do not enable production event forwarding until the Rust host is private, the secret is installed on both sides, and the event inbox has been verified.

### Production cutover gate

The Worker remains the browser API until Rust has feature parity and regression coverage for OAuth/device sessions, account and profile reads, server/channel/member/role permissions, messages, reactions, replies, friends, DMs, uploads, and moderation. A Rust deployment alone does not replace those routes. Keep the existing Worker and Neon database intact throughout the migration.


### Optional staged API proxy

The Worker now has an opt-in route allowlist for Rust. It is disabled unless `RUST_API_ORIGIN` is configured.

When the Rust host is deployed and verified:

1. Set the Cloudflare Worker variable `RUST_API_ORIGIN` to the Rust service's HTTPS origin only (for example, `https://rust-api.example.com`; no path or trailing API prefix).
2. Keep the Rust service reachable only through the intended Cloudflare-protected network path.
3. Verify `/health` and `/ready` on Rust before enabling the variable.
4. Confirm the proxy allowlist tests and Rust CI are green.
5. Enable the variable only after checking the exact routes being forwarded.

Before enabling the proxy, configure these Rust service variables:

- `MALLOWBOT_SERVICE_KEY`: the same private integration key currently used by Mallow-Bot and the Worker.
- `IP_HASH_SECRET`: the exact same secret currently used by the Worker for global IP-ban hashes.
- `MALLOWCORD_DISCORD_GUILD_ID`: the official Discord guild ID. It defaults to the current configured guild if omitted.
- `MALLOWBOT_ICON_URL`: optional public icon URL used for bot-generated command responses.

Do not place these values in the repository or browser configuration. Keep the Rust origin private behind the intended Cloudflare/Worker path; the Worker overwrites and forwards Cloudflare's `CF-Connecting-IP` as `X-MallowCord-Client-IP`, which the Rust IP-ban middleware trusts. The Discord snapshot, presence, message ingestion, account linking, command queue/result, and outgoing-message acknowledgement routes are now implemented in Rust. Mallow-Bot user listing and timeout/ban/unban/delete moderation endpoints are also implemented in Rust. Account contact verification and remaining admin utilities remain on the Worker for now.

Only routes and HTTP methods already implemented in Rust are forwarded. Google/Discord OAuth start and callbacks, OAuth code exchange, contact verification, Mallow-Bot Discord bridge endpoints, and other unported routes continue to run on the Worker. Browser cookies and request bodies are forwarded so the existing same-origin session contract is preserved. The Worker adds CORS support for the Rust section PATCH route.

If Rust is unavailable, forwarded requests return HTTP 502; they do not silently fall back to Worker database writes. Leave `RUST_API_ORIGIN` unset until the Rust service is ready. This branch does not set the variable or change the live deployment.
