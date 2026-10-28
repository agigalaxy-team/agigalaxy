-- Website publication has no business-account or private-chat access. It can
-- recheck the original management principal and its current publication grant.
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
GRANT SELECT ON operations_operator_principals_v1,operations_permission_authority_v1,operations_business_roles_v1,operations_role_assignments_v1 TO galaxy_content_publisher;


-- A settings-only publication must prove its original, bounded General bridge.
-- The publisher cannot update this ledger or inspect service settings/secrets.
GRANT SELECT(endpoint,operation_id,operator_id,input,publication_id) ON operations_system_general_publications_v1 TO galaxy_content_publisher;

-- Recheck current login eligibility without granting account or session writes.
GRANT SELECT(endpoint,operator_id,issuer,external_subject,login_blocked,deleted_at) ON operations_management_accounts_v1 TO galaxy_content_publisher;
