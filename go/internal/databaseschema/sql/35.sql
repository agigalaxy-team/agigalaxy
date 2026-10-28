
ALTER TABLE builder_events DROP CONSTRAINT builder_events_kind_check;
ALTER TABLE builder_events ADD CONSTRAINT builder_events_kind_check
  CHECK(kind IN ('declare','maintenance','heartbeat','compatibility','node-control','node-control-revoke','work-evidence','work-evidence-revoke','probe-request'));
CREATE TABLE builder_probes (
  id uuid PRIMARY KEY,request_id uuid NOT NULL REFERENCES builder_events(id),job_id uuid NOT NULL REFERENCES jobs(id),
  attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 3),observation jsonb NOT NULL CHECK(jsonb_typeof(observation)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(request_id,attempt)
);
