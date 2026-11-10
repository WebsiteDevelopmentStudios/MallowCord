# MallowCord

Discord-inspired community chat for Mallow Swamp.

## Architecture
- Render Static Site hosts public/.
- Cloudflare Worker provides the same-origin API, device authentication and moderation.
- Cloudflare D1 stores users, sessions, recovery codes, servers, roles, channels, messages and audit history.
- Cloudflare DNS/TLS/WAF fronts the custom domain.
- Mallow-Bot uses a server-to-server management integration.

## Implemented foundation
- Username-only basic registration with case-insensitive unique usernames.
- Basic accounts have no password and use persistent HttpOnly device cookies.
- One-time recovery code shown at signup and rotated on recovery.
- Full-access accounts use passwords and can create servers.
- Automatic Mallow Swamp membership.
- Server/channel/message foundation with five-second message polling.
- Owner moderation API primitives for timeout, account ban, account deletion and global IP ban.

## Deployment
See DEPLOYMENT.md and worker/README.md.

## Launch status
This is an initial application foundation, not a finished public Discord replacement. Do not enable public signups until D1 migrations, owner bootstrap, IP-ban checks, rate limiting, server join/invite flows, role enforcement, Mallow-Bot integration and moderation workflows have been tested. Voice/video, uploads, realtime WebSockets and native apps are future phases.
