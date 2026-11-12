CREATE TABLE IF NOT EXISTS oauth_login_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_login_codes_expiry_idx
    ON oauth_login_codes(expires_at);
