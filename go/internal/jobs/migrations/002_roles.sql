-- Administrative provisioning only, after existing Galaxy roles and River DDL.
GRANT USAGE ON SCHEMA galaxy_go_jobs,galaxy_river TO galaxy_api,galaxy_evidence_worker;
GRANT SELECT ON galaxy_go_jobs.control_v1 TO galaxy_api,galaxy_evidence_worker;
-- PostgreSQL row locks require an UPDATE privilege. Only the inert timestamp
-- is grantable; backend activation remains administrator-only.
GRANT UPDATE(updated_at) ON galaxy_go_jobs.control_v1 TO galaxy_api,galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE,DELETE ON galaxy_go_jobs.schedules_v1 TO galaxy_api;
GRANT SELECT ON galaxy_go_jobs.schedules_v1 TO galaxy_evidence_worker;
GRANT UPDATE(next_at,updated_at) ON galaxy_go_jobs.schedules_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT,UPDATE ON galaxy_go_jobs.singleton_slots_v1 TO galaxy_api,galaxy_evidence_worker;
GRANT SELECT,INSERT ON galaxy_go_jobs.executions_v1 TO galaxy_api,galaxy_evidence_worker;
GRANT UPDATE(state,result,error_code,updated_at) ON galaxy_go_jobs.executions_v1 TO galaxy_evidence_worker;
GRANT SELECT,INSERT ON galaxy_river.river_job TO galaxy_api;
-- River v0.50 InsertTx uses ON CONFLICT DO UPDATE kind=river_job.kind even
-- without a unique key; PostgreSQL requires this narrow column grant.
GRANT UPDATE(kind) ON galaxy_river.river_job TO galaxy_api;
-- Explicit domain cancellation/retry uses River's transactional APIs.
GRANT UPDATE(state,finalized_at,metadata,scheduled_at,max_attempts) ON galaxy_river.river_job TO galaxy_api;
GRANT UPDATE(state,error_code,updated_at) ON galaxy_go_jobs.executions_v1 TO galaxy_api;
GRANT UPDATE(superseded_at) ON galaxy_go_jobs.executions_v1 TO galaxy_api,galaxy_evidence_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA galaxy_river TO galaxy_api;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA galaxy_river TO galaxy_evidence_worker;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA galaxy_river TO galaxy_evidence_worker;
-- Neither runtime can update control_v1.backend or activate cutover.
-- Reuse the existing publisher role only when it has already been provisioned.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_content_publisher') THEN
  GRANT USAGE ON SCHEMA galaxy_go_jobs,galaxy_river TO galaxy_content_publisher;
  GRANT SELECT ON galaxy_go_jobs.control_v1 TO galaxy_content_publisher;
  GRANT SELECT,INSERT ON galaxy_go_jobs.executions_v1 TO galaxy_content_publisher;
  GRANT UPDATE(state,result,error_code,updated_at) ON galaxy_go_jobs.executions_v1 TO galaxy_content_publisher;
  GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA galaxy_river TO galaxy_content_publisher;
  GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA galaxy_river TO galaxy_content_publisher;
 END IF;
END $$;
