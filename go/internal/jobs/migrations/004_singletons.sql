-- Exclusive in-flight keys mirror the original queue behavior; completed
-- executions and their original payload/result history remain untouched.
CREATE TABLE IF NOT EXISTS galaxy_go_jobs.singleton_slots_v1(
 endpoint text NOT NULL,
 action text NOT NULL CHECK(action IN('autonomy-task','autonomy-tick')),
 slot_key text NOT NULL,
 execution_id uuid NOT NULL REFERENCES galaxy_go_jobs.executions_v1(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(endpoint,action,slot_key)
);
REVOKE ALL ON galaxy_go_jobs.singleton_slots_v1 FROM PUBLIC;
ALTER TABLE galaxy_go_jobs.singleton_slots_v1 DROP CONSTRAINT IF EXISTS singleton_slots_v1_action_check;
ALTER TABLE galaxy_go_jobs.singleton_slots_v1 ADD CONSTRAINT singleton_slots_v1_action_check
 CHECK(action IN('autonomy-task','autonomy-tick','information-watch'));
