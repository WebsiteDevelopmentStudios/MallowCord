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
