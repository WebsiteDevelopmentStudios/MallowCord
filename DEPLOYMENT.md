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
