# Incremental Neon migration

Production remains on Cloudflare D1 by default. Neon is enabled only for features explicitly listed in `MALLOWCORD_NEON_FEATURES`.

## Current first slice

- `oauth_diagnostics` is the first Neon-routed feature.
- This table is operational diagnostics only; OAuth login and account/session data remain on D1.
- Its writer catches database errors, so a Neon diagnostics failure does not fail login.
- The Neon schema already includes `oauth_diagnostics`.
- Every other query continues using D1. Do not set `MALLOWCORD_DB_BACKEND=neon`; that global switch is reserved for the eventual final migration.

## Feature routing

Set `MALLOWCORD_NEON_FEATURES` to a comma-separated list of feature names. Each selected call uses the Neon Hyperdrive binding. Unlisted calls continue using D1.

Before moving a feature:
1. Confirm its tables and constraints exist in Neon.
2. Confirm it has no joins or transactions that cross database boundaries.
3. Route only its own reads/writes.
4. Verify the feature against live traffic and Neon records.
5. Keep the previous D1 implementation available until verification is complete.

Do not move account preferences, profiles, presence, sessions, messages, or memberships independently until their cross-table dependencies are redesigned. They currently share joins and foreign keys with core D1 tables.

## Deployment

The GitHub Actions workflow runs adapter tests on pull requests. Manual production deployment is available only from the `main` branch and uses Wrangler `--keep-vars` so existing dashboard secrets and variables are retained.

Repository Actions secrets required:
- `CLOUDFLARE_API_TOKEN`: token with Workers Scripts Edit and Hyperdrive Read permissions.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID.

Run the workflow manually from GitHub Actions after the migration PR is reviewed and merged. The initial deployment keeps D1 bound and routes only OAuth diagnostics to Neon.
