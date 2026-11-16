-- A worker claims an event by setting status = 'processing' and locked_at.
-- If it crashes, the row stays 'processing'; once locked_at is older than the
-- lock timeout another worker reclaims it. attempts is incremented at claim
-- time, so a crash counts as an attempt and cannot loop forever.
ALTER TABLE events ADD COLUMN locked_at timestamptz;

CREATE INDEX events_stale_processing_idx ON events (locked_at) WHERE status = 'processing';
