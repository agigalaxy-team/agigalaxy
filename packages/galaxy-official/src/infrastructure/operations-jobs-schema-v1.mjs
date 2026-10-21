import { getConstructionPlans } from 'pg-boss';

// pg-boss 12.38.0 exports a transaction-wrapped install plan. Galaxy already
// owns the migration transaction; retain its SQL/lock but not a nested COMMIT.
const plans = getConstructionPlans('galaxy_jobs');
if (!/^\s*BEGIN;/i.test(plans) || !/COMMIT;\s*$/i.test(plans))
  throw new Error('Unsupported pg-boss construction plan');
const installation = plans.replace(/^\s*BEGIN;/i, '').replace(/COMMIT;\s*$/i, '');
const options = JSON.stringify({
  policy: 'exclusive', retryLimit: 4, retryDelay: 30, retryBackoff: true,
  retryDelayMax: 900, expireInSeconds: 300, heartbeatSeconds: 30,
  retentionSeconds: 604800, deleteAfterSeconds: 604800,
});

export const operationsJobsMigrationSql = `${installation}
SELECT galaxy_jobs.create_queue('information-watch','${options}'::jsonb);
SELECT galaxy_jobs.create_queue('search-recovery','${options}'::jsonb);
SELECT galaxy_jobs.create_queue('content-publication','${options}'::jsonb);
REVOKE ALL ON SCHEMA galaxy_jobs FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA galaxy_jobs FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA galaxy_jobs FROM PUBLIC;

ALTER TABLE information_watches_v2 ADD COLUMN background_authority jsonb;
ALTER TABLE information_watches_v2 ADD COLUMN background_state text NOT NULL DEFAULT 'authorization-required';
ALTER TABLE information_watches_v2 ADD COLUMN background_error text;
CREATE INDEX information_watches_due ON information_watches_v2(next_check_at,id) WHERE state='active';

-- Recover only an authorization actually recorded with a watch command. The
-- old session token is neither read nor needed; binding/control remain live.
UPDATE information_watches_v2 w SET background_authority=jsonb_build_object(
  'bindingId',a.caller_binding_id,'scopes',a.credential_scopes,
  'deviceId',b.device_id,'keyId',b.key_id,'controlEpoch',COALESCE(b.control_epoch,0)),
  background_state=CASE WHEN w.state='active' THEN 'scheduled' ELSE w.state END
FROM audit_events a JOIN bindings b ON b.id=a.caller_binding_id
WHERE a.sequence=(SELECT max(prior.sequence) FROM audit_events prior
  WHERE prior.actor=w.subject_id AND prior.object_id=w.id::text
  AND prior.action='notification.preferences' AND prior.idempotency_key LIKE 'information-watch:%'
  AND prior.outcome='accepted')
AND b.subject_id=w.subject_id AND jsonb_typeof(a.credential_scopes)='array';

ALTER TABLE jobs ADD COLUMN search_recovery_count integer NOT NULL DEFAULT 0 CHECK(search_recovery_count>=0);
ALTER TABLE jobs ADD COLUMN search_recovery_generation integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN search_recovery_at timestamptz;
CREATE INDEX search_failed_recovery ON jobs(available_at,id) WHERE kind='search-index' AND state='failed';

CREATE FUNCTION public.galaxy_remove_watch_jobs_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  DELETE FROM galaxy_jobs.job WHERE name='information-watch' AND data->>'watchId'=OLD.id::text;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.galaxy_remove_watch_jobs_v1() FROM PUBLIC;
CREATE TRIGGER remove_information_watch_jobs AFTER DELETE ON information_watches_v2
FOR EACH ROW EXECUTE FUNCTION public.galaxy_remove_watch_jobs_v1();
CREATE FUNCTION public.galaxy_remove_search_recovery_jobs_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.kind='search-index' THEN
    DELETE FROM galaxy_jobs.job WHERE name='search-recovery' AND data->>'jobId'=OLD.id::text;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.galaxy_remove_search_recovery_jobs_v1() FROM PUBLIC;
CREATE TRIGGER remove_search_recovery_jobs AFTER DELETE ON jobs
FOR EACH ROW EXECUTE FUNCTION public.galaxy_remove_search_recovery_jobs_v1();
`;

// Root appends these to its existing administrative role provisioning. There is
// no schema ownership/CREATE grant and no new access to private source tables.
const queueRole = role => `
GRANT USAGE ON SCHEMA galaxy_jobs TO ${role};
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA galaxy_jobs TO ${role};
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA galaxy_jobs TO ${role};
GRANT EXECUTE ON FUNCTION galaxy_jobs.job_now() TO ${role};
GRANT USAGE ON TYPE galaxy_jobs.job_state TO ${role};
`;
export const operationsJobsApiRoleSql = queueRole('galaxy_api');
export const operationsJobsWorkerRoleSql = queueRole('galaxy_evidence_worker') + `
GRANT UPDATE(search_recovery_count,search_recovery_generation,search_recovery_at) ON jobs TO galaxy_evidence_worker;
`;
