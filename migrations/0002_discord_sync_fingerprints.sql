CREATE TABLE IF NOT EXISTS discord_sync_fingerprints (
    guild_id TEXT NOT NULL,
    snapshot_key TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, snapshot_key)
);
