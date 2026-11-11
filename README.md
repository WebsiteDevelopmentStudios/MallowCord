# MallowCord

Discord-inspired community chat for Mallow Swamp.

## Architecture
- Render Static Site hosts public/.
- Cloudflare Worker provides the same-origin API, device authentication and moderation.
- Cloudflare D1 stores users, sessions, recovery codes, servers, roles, channels, messages and audit history.
- Cloudflare DNS/TLS/WAF fronts the custom domain.
- Mallow-Bot uses a server-to-server management integration.

## Implemented foundation
- Google and Discord OAuth sign-in with provider identities stored server-side.
- New accounts receive a generated unique username and secure HttpOnly device session.
- Owner privileges are assigned only to the configured verified Google email or Discord user ID.
- Username/password registration and recovery-code sign-in are disabled.
- Automatic Mallow Swamp membership.
- Server/channel/message foundation with five-second message polling.
- Owner moderation API primitives for timeout, account ban, account deletion and global IP ban.

## Deployment
See DEPLOYMENT.md and worker/README.md.

## Launch status
This is an initial application foundation, not a finished public Discord replacement. Do not enable public signups until D1 migrations, owner bootstrap, IP-ban checks, rate limiting, server join/invite flows, role enforcement, Mallow-Bot integration and moderation workflows have been tested. Voice/video, uploads, realtime WebSockets and native apps are future phases.
