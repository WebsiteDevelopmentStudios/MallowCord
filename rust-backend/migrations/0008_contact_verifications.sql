CREATE TABLE IF NOT EXISTS contact_verifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
    target TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS contact_verifications_expiry_idx
    ON contact_verifications(expires_at);

CREATE INDEX IF NOT EXISTS contact_verifications_user_channel_idx
    ON contact_verifications(user_id, channel, created_at DESC);
