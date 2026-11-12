CREATE TABLE IF NOT EXISTS event_inbox (
    event_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS event_inbox_pending_idx
    ON event_inbox (received_at)
    WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS event_inbox_source_type_idx
    ON event_inbox (source, event_type, received_at DESC);
