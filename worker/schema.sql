PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL COLLATE NOCASE UNIQUE,username_key TEXT NOT NULL UNIQUE,account_type TEXT NOT NULL CHECK(account_type IN('basic','full','owner')) DEFAULT 'basic',password_hash TEXT,status TEXT NOT NULL DEFAULT 'active' CHECK(status IN('active','timed_out','banned','deleted')),timeout_until INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,user_agent TEXT,ip_hash TEXT);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS recovery_codes(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,created_at INTEGER NOT NULL,used_at INTEGER);
CREATE TABLE IF NOT EXISTS servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),icon_url TEXT,is_system INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,joined_at INTEGER NOT NULL,PRIMARY KEY(server_id,user_id));
CREATE TABLE IF NOT EXISTS roles(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,name TEXT NOT NULL,is_system INTEGER NOT NULL DEFAULT 0,position INTEGER NOT NULL DEFAULT 0,color TEXT NOT NULL DEFAULT '#99aab5',pingable INTEGER NOT NULL DEFAULT 1,UNIQUE(server_id,name));
CREATE TABLE IF NOT EXISTS member_roles(server_id TEXT NOT NULL,user_id TEXT NOT NULL,role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,PRIMARY KEY(server_id,user_id,role_id),FOREIGN KEY(server_id,user_id) REFERENCES memberships(server_id,user_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,name TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'text',position INTEGER NOT NULL DEFAULT 0,section_id TEXT);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,author_id TEXT NOT NULL REFERENCES users(id),content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),created_at INTEGER NOT NULL,edited_at INTEGER);

CREATE TABLE IF NOT EXISTS server_sections(id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,name TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,UNIQUE(server_id,name));
CREATE TABLE IF NOT EXISTS channel_permissions(channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,target_type TEXT NOT NULL CHECK(target_type IN('role','user')),target_id TEXT NOT NULL,allow_json TEXT NOT NULL DEFAULT '[]',deny_json TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(channel_id,target_type,target_id));

CREATE TABLE IF NOT EXISTS discord_user_links(discord_user_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS discord_account_links(discord_user_id TEXT PRIMARY KEY,server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,updated_at INTEGER NOT NULL,UNIQUE(server_id,user_id));
CREATE TABLE IF NOT EXISTS discord_link_codes(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS discord_command_jobs(id TEXT PRIMARY KEY,server_id TEXT NOT NULL,channel_id TEXT NOT NULL,user_id TEXT NOT NULL,discord_user_id TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',created_at INTEGER NOT NULL,processed_at INTEGER);
CREATE INDEX IF NOT EXISTS discord_command_jobs_queued_created_idx ON discord_command_jobs(created_at) WHERE status='queued';
CREATE INDEX IF NOT EXISTS discord_command_jobs_processing_time_idx ON discord_command_jobs(processed_at) WHERE status='processing';
CREATE TABLE IF NOT EXISTS discord_outbox(id TEXT PRIMARY KEY,discord_channel_id TEXT NOT NULL,message_id TEXT NOT NULL UNIQUE,username TEXT NOT NULL,avatar_url TEXT,content TEXT NOT NULL,created_at INTEGER NOT NULL,processed_at INTEGER,discord_message_id TEXT);
CREATE INDEX IF NOT EXISTS discord_outbox_pending_created_idx ON discord_outbox(created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages(channel_id,created_at DESC);
CREATE TABLE IF NOT EXISTS bans(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,ip_hash TEXT,reason TEXT,created_by TEXT NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,expires_at INTEGER,CHECK(user_id IS NOT NULL OR ip_hash IS NOT NULL));
CREATE INDEX IF NOT EXISTS bans_ip_idx ON bans(ip_hash);
CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,actor_id TEXT,target_user_id TEXT,action TEXT NOT NULL,details TEXT,created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS oauth_states(state_hash TEXT PRIMARY KEY,provider TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_accounts(provider TEXT NOT NULL,provider_user_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,email TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(provider,provider_user_id),UNIQUE(provider,user_id));
CREATE TABLE IF NOT EXISTS oauth_login_codes(code_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
