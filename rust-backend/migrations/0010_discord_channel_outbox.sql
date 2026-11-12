-- Index the existing bridge tables for channel lookups and pending outbox delivery.
CREATE INDEX IF NOT EXISTS discord_channel_links_server_idx
    ON discord_channel_links(server_id, mallow_channel_id);

CREATE INDEX IF NOT EXISTS discord_outbox_pending_idx
    ON discord_outbox(processed_at, created_at);
