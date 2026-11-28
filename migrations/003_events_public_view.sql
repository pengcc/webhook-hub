-- What the read API may see: delivery metadata and processing state, without
-- the order payload and without raw error text (only whether one exists).
-- The read-only role needs CONNECT on the database (production revokes it
-- from PUBLIC) and SELECT on this view, and nothing on the events table: the
-- view runs with its owner's rights (security_invoker is off).
--
-- A later migration that changes or drops a column used here must drop and
-- recreate the view. DROP VIEW also drops its grants, so re-grant SELECT to
-- webhook_hub_read in the same migration, or the read API returns 500.
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
