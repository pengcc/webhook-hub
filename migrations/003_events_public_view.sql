-- What the read API may see: delivery metadata and processing state, without
-- the order payload and without raw error text (only whether one exists).
-- The read-only role gets SELECT on this view and nothing else. The view runs
-- with its owner's rights (security_invoker is off), so that role needs no
-- privilege on the events table itself.
CREATE VIEW events_public AS
SELECT id, source, event_id, correlation_id, topic, shop, status, attempts,
       received_at, next_attempt_at, processed_at,
       (last_error IS NOT NULL) AS has_error
  FROM events;

-- Convenience for a fresh install where the role already exists. The result
-- depends on cluster state (roles are cluster-wide and created by a
-- superuser), so the reliable grant is the "Read-only role" step in
-- deploy/README.md, which always grants and can be re-run.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'webhook_hub_read') THEN
    GRANT SELECT ON events_public TO webhook_hub_read;
  END IF;
END
$$;
