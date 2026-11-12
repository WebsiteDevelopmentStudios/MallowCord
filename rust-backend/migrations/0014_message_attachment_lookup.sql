-- Message history fetches attachment metadata for a page of message IDs.
-- The channel/time index serves channel listing; this partial index serves
-- the per-page message_id lookup without indexing unattached upload rows.
CREATE INDEX IF NOT EXISTS message_attachments_message_idx
    ON message_attachments(message_id)
    WHERE message_id IS NOT NULL;
