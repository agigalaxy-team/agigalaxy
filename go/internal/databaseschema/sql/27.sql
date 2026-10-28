
ALTER TABLE deletion_requests ADD COLUMN minimized_at timestamptz;
ALTER TABLE deletion_events ADD COLUMN payload_minimized boolean NOT NULL DEFAULT false;
ALTER TABLE deletion_events ADD COLUMN retained_payload jsonb;
ALTER TABLE deletion_events ADD COLUMN retained_hash text;
ALTER TABLE deletion_events ADD CONSTRAINT deletion_retained_payload CHECK (
  (NOT payload_minimized AND retained_payload IS NULL AND retained_hash IS NULL) OR
  (payload_minimized AND actor_kind='operator' AND signature IS NULL AND payload_text='' AND retained_payload IS NOT NULL AND retained_hash IS NOT NULL AND retained_hash ~ '^[a-f0-9]{64}$'));
ALTER TABLE deletion_events DROP CONSTRAINT deletion_events_kind_check;
ALTER TABLE deletion_events ADD CONSTRAINT deletion_events_kind_check CHECK(kind IN ('request','cancel','needs-information','approve','reject','execute','minimize'));
