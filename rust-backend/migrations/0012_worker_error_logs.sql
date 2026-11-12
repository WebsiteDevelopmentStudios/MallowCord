-- The Worker still records request exceptions into Neon. Rust owns the
-- owner-only read and clear API so the admin tools no longer need Worker SQL.
CREATE TABLE IF NOT EXISTS worker_error_logs (
    id TEXT PRIMARY KEY,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    message TEXT NOT NULL,
    stack TEXT,
    origin TEXT,
    user_agent TEXT,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS worker_error_logs_created_idx
    ON worker_error_logs(created_at DESC);
