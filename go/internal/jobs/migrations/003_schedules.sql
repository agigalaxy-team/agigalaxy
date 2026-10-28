-- Durable business schedules; no rows are created or enabled by migration.
CREATE TABLE IF NOT EXISTS galaxy_go_jobs.schedules_v1(
 endpoint text NOT NULL,
 queue text NOT NULL CHECK(queue='messaging-run'),
 key text NOT NULL,
 cron text NOT NULL,
 timezone text NOT NULL,
 payload jsonb NOT NULL,
 missed text NOT NULL CHECK(missed='skip'),
 next_at timestamptz NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(endpoint,queue,key)
);
CREATE INDEX IF NOT EXISTS schedules_v1_due ON galaxy_go_jobs.schedules_v1(endpoint,next_at);
REVOKE ALL ON galaxy_go_jobs.schedules_v1 FROM PUBLIC;
