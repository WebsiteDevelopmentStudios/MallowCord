CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT,
    avatar_url TEXT,
    email TEXT,
    email_verified_at BIGINT,
    phone TEXT,
    phone_verified_at BIGINT,
    updated_at BIGINT NOT NULL DEFAULT 0,
    bio TEXT,
    status TEXT NOT NULL DEFAULT 'online',
    pronouns TEXT,
    discord_username TEXT
);
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'online';
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS pronouns TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS discord_username TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email_verified_at BIGINT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS phone_verified_at BIGINT;

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL DEFAULT '{}',
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_presence (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_seen_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(sender_id, recipient_id),
    CHECK(sender_id <> recipient_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_recipient_idx
    ON friend_requests(recipient_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_requests_sender_idx
    ON friend_requests(sender_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS friendships (
    user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    PRIMARY KEY(user_low_id, user_high_id),
    CHECK(user_low_id < user_high_id)
);
CREATE INDEX IF NOT EXISTS friendships_high_idx ON friendships(user_high_id);

CREATE TABLE IF NOT EXISTS dm_conversations (
    id TEXT PRIMARY KEY,
    user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    UNIQUE(user_low_id, user_high_id),
    CHECK(user_low_id < user_high_id)
);
CREATE INDEX IF NOT EXISTS dm_conversations_low_idx ON dm_conversations(user_low_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS dm_conversations_high_idx ON dm_conversations(user_high_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dm_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
    created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS dm_messages_conversation_idx
    ON dm_messages(conversation_id, created_at DESC);
