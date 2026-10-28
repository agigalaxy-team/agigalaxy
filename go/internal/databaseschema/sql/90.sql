
ALTER TABLE official_account_profiles_v1
 ADD COLUMN query_linked_ids boolean NOT NULL DEFAULT false,
 ADD COLUMN query_external_credentials boolean NOT NULL DEFAULT false;
