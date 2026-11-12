ALTER TABLE event_inbox
    ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS event_inbox_ready_idx
    ON event_inbox (next_attempt_at, received_at)
    WHERE processed_at IS NULL AND dead_lettered_at IS NULL;
