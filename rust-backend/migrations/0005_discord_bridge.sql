CREATE TABLE IF NOT EXISTS discord_user_links (
    discord_user_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_user_links_user_idx
    ON discord_user_links(server_id, user_id);

CREATE TABLE IF NOT EXISTS discord_account_links (
    discord_user_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    updated_at BIGINT NOT NULL,
    UNIQUE(server_id, user_id)
);

CREATE TABLE IF NOT EXISTS discord_link_codes (
    code_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_role_links (
    discord_role_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS discord_role_links_server_idx
    ON discord_role_links(server_id, role_id);

CREATE TABLE IF NOT EXISTS discord_message_links (
    discord_message_id TEXT PRIMARY KEY,
    mallow_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    discord_channel_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_message_links_mallow_idx
    ON discord_message_links(mallow_message_id);

CREATE TABLE IF NOT EXISTS discord_emoji_links (
    discord_emoji_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    emoji_id TEXT NOT NULL REFERENCES server_emojis(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discord_command_jobs (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at BIGINT NOT NULL,
    processed_at BIGINT
);
CREATE INDEX IF NOT EXISTS discord_command_jobs_queue_idx
    ON discord_command_jobs(status, created_at);
