CREATE TABLE IF NOT EXISTS discord_channel_links (
    discord_channel_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    mallow_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    category_name TEXT,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS discord_channel_links_server_idx
    ON discord_channel_links(server_id, mallow_channel_id);

CREATE TABLE IF NOT EXISTS discord_outbox (
    id TEXT PRIMARY KEY,
    discord_channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    avatar_url TEXT,
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    processed_at BIGINT,
    discord_message_id TEXT
);

CREATE INDEX IF NOT EXISTS discord_outbox_pending_idx
    ON discord_outbox(processed_at, created_at);
