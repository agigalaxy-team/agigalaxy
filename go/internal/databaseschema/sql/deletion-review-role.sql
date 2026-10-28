-- Explicit local/operator provisioning. This role records policy reviews only.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='galaxy_deletion_reviewer') THEN CREATE ROLE galaxy_deletion_reviewer NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO galaxy_deletion_reviewer;
GRANT SELECT ON deletion_requests,deletion_events TO galaxy_deletion_reviewer;
GRANT UPDATE (state,revision,updated_at) ON deletion_requests TO galaxy_deletion_reviewer;
GRANT INSERT ON deletion_events TO galaxy_deletion_reviewer;
