ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_content_check;
ALTER TABLE messages ADD CONSTRAINT messages_content_check CHECK (length(content) <= 4000);

CREATE TABLE IF NOT EXISTS message_replies (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    reply_to_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY(message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS message_attachments (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size BIGINT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_forwards (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    source_message_id TEXT,
    source_username TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('mention', 'reply')),
    created_at BIGINT NOT NULL,
    seen_at BIGINT,
    UNIQUE(user_id, message_id, kind)
);
CREATE INDEX IF NOT EXISTS message_notifications_unread_idx
    ON message_notifications(user_id, created_at DESC)
    WHERE seen_at IS NULL;

CREATE TABLE IF NOT EXISTS bot_messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    source_user_id TEXT REFERENCES users(id),
    username TEXT NOT NULL,
    avatar_url TEXT,
    content TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

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

CREATE TABLE IF NOT EXISTS user_notification_settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_type TEXT NOT NULL CHECK(scope_type IN ('server', 'channel')),
    scope_id TEXT NOT NULL,
    muted BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY(user_id, scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS server_emojis (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    image_url TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    UNIQUE(server_id, name)
);
