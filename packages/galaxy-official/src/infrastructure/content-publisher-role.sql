-- Website publication has no business-account, private-chat or identity access.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_content_publisher') THEN
    CREATE ROLE galaxy_content_publisher NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public,galaxy_jobs TO galaxy_content_publisher;
GRANT SELECT ON schema_migrations,site_publications_v1 TO galaxy_content_publisher;
GRANT UPDATE(state,attempts,result,error,created_at,updated_at,published_at) ON site_publications_v1 TO galaxy_content_publisher;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA galaxy_jobs TO galaxy_content_publisher;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA galaxy_jobs TO galaxy_content_publisher;
GRANT EXECUTE ON FUNCTION galaxy_jobs.job_now() TO galaxy_content_publisher;
GRANT USAGE ON TYPE galaxy_jobs.job_state TO galaxy_content_publisher;
