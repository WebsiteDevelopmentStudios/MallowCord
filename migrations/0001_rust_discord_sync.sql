-- Rust/D1 bridge schema. Every statement is additive and safe to apply to the
-- existing mallowcord database. No existing tables or records are dropped.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  email TEXT,
  email_verified_at INTEGER,
  phone TEXT,
  phone_verified_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS discord_channel_links (
  discord_channel_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  mallow_channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  category_name TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_channel_links_server_idx
  ON discord_channel_links(server_id, discord_channel_id);

CREATE TABLE IF NOT EXISTS discord_role_links (
  discord_role_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS discord_role_links_server_idx
  ON discord_role_links(server_id, discord_role_id);

CREATE TABLE IF NOT EXISTS discord_user_links (
  discord_user_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_user_links_server_idx
  ON discord_user_links(server_id, discord_user_id);

CREATE TABLE IF NOT EXISTS discord_account_links (
  discord_user_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL,
  UNIQUE(server_id, user_id)
);

CREATE TABLE IF NOT EXISTS discord_message_links (
  discord_message_id TEXT PRIMARY KEY,
  mallow_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  discord_channel_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS discord_message_links_channel_idx
  ON discord_message_links(discord_channel_id);

CREATE TABLE IF NOT EXISTS discord_sync_cursors (
  sync_key TEXT PRIMARY KEY,
  cursor_value TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_permissions (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK(target_type IN ('role','user')),
  target_id TEXT NOT NULL,
  allow_json TEXT NOT NULL DEFAULT '[]',
  deny_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(channel_id,target_type,target_id)
);

CREATE TABLE IF NOT EXISTS server_emojis (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  image_url TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  UNIQUE(server_id,name)
);
CREATE TABLE IF NOT EXISTS discord_emoji_links (
  discord_emoji_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  emoji_id TEXT NOT NULL REFERENCES server_emojis(id) ON DELETE CASCADE
);
