-- Inbound webhook events. A verified event is stored here first and acknowledged;
-- a worker processes it afterwards.
CREATE TABLE events (
  id               bigserial PRIMARY KEY,
  source           text        NOT NULL,
  -- Delivery identity used for deduplication. For Shopify this is
  -- X-Shopify-Webhook-Id, which is stable across retries of one delivery.
  event_id         text        NOT NULL,
  -- Optional correlation id (Shopify: X-Shopify-Event-Id). Not unique: several
  -- subscriptions to one merchant action share it.
  correlation_id   text,
  topic            text        NOT NULL,
  shop             text,
  payload          jsonb       NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  status           text        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'done', 'failed', 'dead')),
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  processed_at     timestamptz,
  CONSTRAINT events_source_event_id_key UNIQUE (source, event_id)
);

-- Lets the worker find due work cheaply.
CREATE INDEX events_due_idx ON events (next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX events_received_at_idx ON events (received_at DESC);
