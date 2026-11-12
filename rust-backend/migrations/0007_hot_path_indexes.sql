-- Hot-path indexes for the Rust API. All are additive and safe to apply repeatedly.
CREATE INDEX IF NOT EXISTS sessions_token_hash_idx
    ON sessions(token_hash);

CREATE INDEX IF NOT EXISTS memberships_user_server_idx
    ON memberships(user_id, server_id);

CREATE INDEX IF NOT EXISTS messages_channel_idx
    ON messages(channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS discord_outbox_pending_idx
    ON discord_outbox(created_at)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS message_attachments_channel_created_idx
    ON message_attachments(channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS server_sections_server_position_idx
    ON server_sections(server_id, position, name);
