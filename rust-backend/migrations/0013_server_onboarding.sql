CREATE TABLE IF NOT EXISTS server_onboarding (
    server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 0,
    welcome_text TEXT NOT NULL DEFAULT '',
    rules_text TEXT NOT NULL DEFAULT '',
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_completions (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    completed_at BIGINT NOT NULL,
    PRIMARY KEY(server_id, user_id)
);

CREATE INDEX IF NOT EXISTS onboarding_completions_user_idx
    ON onboarding_completions(user_id, completed_at DESC);
