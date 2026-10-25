// Reversible operations access only. No attachment FK or storage/retention
// mutation: owner deletion and the original attachment lifetime remain free.
export const operationsFileAccessV1Sql=`
CREATE TABLE operations_file_access_heads_v1(
 endpoint text NOT NULL,kind text NOT NULL CHECK(kind IN('chat','forum')),file_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),stopped_until timestamptz,
 operation_id uuid NOT NULL,operator_id text NOT NULL,reason text NOT NULL,updated_at timestamptz NOT NULL,
 PRIMARY KEY(endpoint,kind,file_id)
);
CREATE TABLE operations_file_access_events_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,kind text NOT NULL CHECK(kind IN('chat','forum')),file_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),operation_id uuid NOT NULL,operator_id text NOT NULL,
 action text NOT NULL CHECK(action IN('stop','restore')),stopped_until timestamptz,reason text NOT NULL,
 expected_version text NOT NULL,expected_revision integer NOT NULL CHECK(expected_revision>=0),created_at timestamptz NOT NULL,
 UNIQUE(endpoint,operation_id),UNIQUE(endpoint,kind,file_id,revision),
 CHECK((action='stop' AND stopped_until IS NOT NULL) OR (action='restore' AND stopped_until IS NULL))
);
CREATE INDEX operations_file_access_events_history_v1 ON operations_file_access_events_v1(endpoint,kind,file_id,revision DESC);
DO $file_access$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint
 WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'file_access_audit_constraint_missing';END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
  'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action IN (''file-access-read'',''file-access-stop'',''file-access-restore''))';
END $file_access$;
`;
