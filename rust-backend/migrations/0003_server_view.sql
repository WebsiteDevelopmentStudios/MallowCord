ALTER TABLE roles ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#99aab5';
ALTER TABLE roles ADD COLUMN IF NOT EXISTS pingable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS section_id TEXT;

CREATE TABLE IF NOT EXISTS server_sections (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    UNIQUE(server_id, name)
);

CREATE TABLE IF NOT EXISTS channel_permissions (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('role', 'user')),
    target_id TEXT NOT NULL,
    allow_json TEXT NOT NULL DEFAULT '[]',
    deny_json TEXT NOT NULL DEFAULT '[]',
    updated_at BIGINT NOT NULL,
    PRIMARY KEY(channel_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS discord_channel_links (
    discord_channel_id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    mallow_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    category_name TEXT,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_channel_links_mallow_idx
    ON discord_channel_links(mallow_channel_id, server_id);
