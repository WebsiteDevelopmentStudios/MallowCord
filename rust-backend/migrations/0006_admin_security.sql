CREATE TABLE IF NOT EXISTS bans (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    server_id TEXT REFERENCES servers(id) ON DELETE CASCADE,
    ip_hash TEXT,
    reason TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    expires_at BIGINT,
    CHECK(user_id IS NOT NULL OR ip_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS bans_ip_idx ON bans(ip_hash);
CREATE INDEX IF NOT EXISTS bans_server_idx ON bans(server_id, user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_id TEXT,
    target_user_id TEXT,
    action TEXT NOT NULL,
    details TEXT,
    created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx
    ON audit_logs(created_at DESC);
