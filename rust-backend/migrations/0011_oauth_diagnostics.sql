-- OAuth diagnostics are written by the Rust callback handlers. The Worker used
-- to create this table lazily; make it an explicit, versioned Rust dependency.
CREATE TABLE IF NOT EXISTS oauth_diagnostics (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    stage TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_diagnostics_created_idx
    ON oauth_diagnostics(created_at DESC);

CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx
    ON oauth_states(expires_at);
