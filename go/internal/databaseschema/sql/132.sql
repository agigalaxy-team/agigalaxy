
ALTER TABLE official_account_sessions_v1 DROP CONSTRAINT official_account_sessions_v1_check;
ALTER TABLE official_account_sessions_v1 ADD CHECK(expires_at > created_at AND expires_at <= created_at + 31536000);

ALTER TABLE official_account_sessions_v1
 ADD COLUMN refresh_cipher text,
 ADD COLUMN upstream_expires_at bigint,
 ADD COLUMN idle_expires_at bigint,
 ADD COLUMN max_expires_at bigint,
 ADD COLUMN refresh_version integer NOT NULL DEFAULT 0,
 ADD COLUMN refresh_state text NOT NULL DEFAULT 'ready' CHECK(refresh_state IN ('ready','refreshing','unknown','revoked'));

ALTER TABLE operations_operator_sessions_v1
 ADD COLUMN refresh_cipher text,
 ADD COLUMN upstream_expires_at bigint,
 ADD COLUMN idle_expires_at bigint,
 ADD COLUMN max_expires_at bigint,
 ADD COLUMN refresh_version integer NOT NULL DEFAULT 0,
 ADD COLUMN refresh_state text NOT NULL DEFAULT 'ready' CHECK(refresh_state IN ('ready','refreshing','unknown','revoked'));

