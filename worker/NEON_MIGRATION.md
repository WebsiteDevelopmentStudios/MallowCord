# Neon migration runbook

## Current safe state

- Production remains on Cloudflare D1.
- The D1 binding `DB` remains in `wrangler.jsonc` as the rollback path.
- The Neon Hyperdrive binding `NEON` is configured.
- The Worker supports both backends behind the `MALLOWCORD_DB_BACKEND` variable.
- Do not set that variable to `neon` in production until the preflight checks below pass.

## Files added

- `worker/postgres-adapter.js`: PostgreSQL-backed compatibility layer for the existing D1-style `prepare/bind/first/all/run/batch` calls.
- `worker/postgres-adapter.test.js`: SQL conversion tests.
- `package.json`: pins the `postgres` runtime dependency and Wrangler.
- `wrangler.jsonc`: enables `nodejs_compat` and binds Hyperdrive as `NEON`, while retaining D1 as `DB`.

## Preflight

1. Run `npm install`.
2. Run `npm run test:worker`.
3. Deploy the updated Worker with no `MALLOWCORD_DB_BACKEND` variable set. It will continue using D1.
4. Confirm the existing production API still works.
5. Use a separate staging Worker/environment with `MALLOWCORD_DB_BACKEND=neon` and the same Hyperdrive binding.
6. Test OAuth sign-in, basic registration, owner bootstrap, sessions, server creation, channels, role assignment, member listing, messages, attachments, reactions, replies, friendships, and DMs.
7. Confirm the expected rows are created in Neon before considering a production switch.

## Switching and rollback

Only after explicit owner approval, set the Worker variable `MALLOWCORD_DB_BACKEND=neon` and deploy. The Worker will then use `env.NEON.connectionString`.

To roll back, remove that variable (or set it to any value other than `neon`) and redeploy. The D1 database has not been modified by this migration preparation.

## Initial clean database

The Neon project currently has all 45 application tables referenced by the Worker. With an empty database, normal registration and application flows create their own user, session, membership, message, role, and related records. The one-time owner bootstrap endpoint still requires the existing `BOOTSTRAP_SECRET` and a configured `OWNER_PASSWORD`; do not commit either secret.
