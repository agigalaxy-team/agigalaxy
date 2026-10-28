
CREATE TABLE official_account_registrations_v1(
 account_id uuid PRIMARY KEY,uid text NOT NULL UNIQUE CHECK(uid ~ '^G[A-Z0-9]{10}[0-9]$'),
 endpoint text NOT NULL,issuer text NOT NULL,external_subject text NOT NULL,
 display_name text CHECK(display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 120),
 avatar_key text CHECK(avatar_key IS NULL OR avatar_key IN ('orbit','camera','book','leaf','mountain','palette','music','sunrise')),
 bio text NOT NULL DEFAULT '' CHECK(char_length(bio)<=500),
 preset_revision integer NOT NULL DEFAULT 0 CHECK(preset_revision>=0),
 preset_updated_by text REFERENCES operations_operator_principals_v1(operator_id),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,adopted_at timestamptz,
 CHECK(adopted_at IS NULL OR (display_name IS NULL AND avatar_key IS NULL AND bio='')),
 UNIQUE(endpoint,issuer,external_subject),UNIQUE(account_id,uid,endpoint,issuer,external_subject));
-- Preserve all current authenticated IDs/UIDs, including other providers.
INSERT INTO official_account_registrations_v1(account_id,uid,endpoint,issuer,external_subject,created_at,updated_at)
 SELECT id,uid,endpoint,issuer,external_subject,created_at,created_at FROM community_accounts;
CREATE FUNCTION galaxy_account_registration_immutable_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF (NEW.account_id,NEW.uid,NEW.endpoint,NEW.issuer,NEW.external_subject,NEW.created_at)
  IS DISTINCT FROM (OLD.account_id,OLD.uid,OLD.endpoint,OLD.issuer,OLD.external_subject,OLD.created_at) THEN
  RAISE EXCEPTION 'account_registration_immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.adopted_at IS NOT NULL AND NEW.adopted_at IS DISTINCT FROM OLD.adopted_at THEN
  RAISE EXCEPTION 'account_registration_adoption_immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION galaxy_account_registration_immutable_v1() FROM PUBLIC;
CREATE TRIGGER official_account_registration_immutable BEFORE UPDATE ON official_account_registrations_v1
 FOR EACH ROW EXECUTE FUNCTION galaxy_account_registration_immutable_v1();
-- Internal legacy/import INSERTs claim this same unique source, too.
CREATE FUNCTION galaxy_bind_account_registration_v1() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 INSERT INTO public.official_account_registrations_v1(account_id,uid,endpoint,issuer,external_subject,created_at,updated_at)
  VALUES(NEW.id,NEW.uid,NEW.endpoint,NEW.issuer,NEW.external_subject,NEW.created_at,NEW.created_at) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM public.official_account_registrations_v1 r WHERE r.account_id=NEW.id AND r.uid=NEW.uid
  AND r.endpoint=NEW.endpoint AND r.issuer=NEW.issuer AND r.external_subject=NEW.external_subject) THEN
  RAISE EXCEPTION 'account_registration_binding_conflict' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
REVOKE ALL ON FUNCTION galaxy_bind_account_registration_v1() FROM PUBLIC;
CREATE TRIGGER community_account_registration_binding BEFORE INSERT ON community_accounts
 FOR EACH ROW EXECUTE FUNCTION galaxy_bind_account_registration_v1();
ALTER TABLE community_accounts ADD CONSTRAINT community_account_registration_fk
 FOREIGN KEY(id,uid,endpoint,issuer,external_subject)
 REFERENCES official_account_registrations_v1(account_id,uid,endpoint,issuer,external_subject);
DO $registration_audit$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO previous FROM pg_constraint
 WHERE conrelid='business_admin_audit_v1'::regclass AND conname='business_admin_audit_v1_action_check';
 IF previous IS NULL OR previous NOT LIKE 'CHECK (%' THEN RAISE EXCEPTION 'registration_audit_constraint_missing'; END IF;
 ALTER TABLE business_admin_audit_v1 DROP CONSTRAINT business_admin_audit_v1_action_check;
 EXECUTE 'ALTER TABLE business_admin_audit_v1 ADD CONSTRAINT business_admin_audit_v1_action_check '||
  'CHECK (('||substring(previous from 8 for length(previous)-8)||') OR action=''registered-user-profile-preset'')';
END $registration_audit$;
ALTER TABLE operations_registered_commands_v1 DROP CONSTRAINT operations_registered_commands_v1_kind_check,
 ADD CONSTRAINT operations_registered_commands_v1_kind_check CHECK(kind IN
 ('password-reset','login-disable','login-restore','sessions-revoke','profile-correct','profile-preset'));
