
ALTER TABLE deletion_requests ADD COLUMN execution_result jsonb;
ALTER TABLE deletion_requests DROP CONSTRAINT deletion_requests_state_check;
ALTER TABLE deletion_requests ADD CONSTRAINT deletion_requests_state_check CHECK(state IN ('requested','review-needed','approved','rejected','cancelled','partial','primary-erased'));
DROP INDEX deletion_active_subject;
CREATE UNIQUE INDEX deletion_active_subject ON deletion_requests(subject_id) WHERE state IN ('requested','review-needed','approved','partial','primary-erased');
ALTER TABLE deletion_events DROP CONSTRAINT deletion_events_kind_check;
ALTER TABLE deletion_events ADD CONSTRAINT deletion_events_kind_check CHECK(kind IN ('request','cancel','needs-information','approve','reject','execute'));
CREATE TABLE deletion_executions (
  id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES deletion_requests(id),subject_id text NOT NULL,
  command_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
