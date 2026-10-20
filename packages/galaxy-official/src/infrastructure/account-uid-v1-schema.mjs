export const accountUidV1MigrationSql=`
ALTER TABLE community_accounts ADD COLUMN uid text;

-- Also supplies a well-formed UID to internal import/maintenance inserts that
-- omit it. Normal account creation retries conflicting inserts in application
-- code, using the unique constraint as the final concurrent authority.
CREATE FUNCTION galaxy_new_account_uid_v1() RETURNS text LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  candidate text;
  attempt integer;
  character_index integer;
BEGIN
  FOR attempt IN 1..32 LOOP
    candidate := 'G';
    FOR character_index IN 1..10 LOOP
      candidate := candidate || substr(alphabet,1+floor(random()*36)::integer,1);
    END LOOP;
    candidate := candidate || floor(random()*10)::integer::text;
    IF NOT EXISTS(SELECT 1 FROM community_accounts WHERE uid=candidate) THEN
      RETURN candidate;
    END IF;
  END LOOP;
  RAISE EXCEPTION 'account_uid_generation_unavailable';
END;
$$;

-- ALTER TABLE holds the table lock until this migration transaction commits.
DO $$
DECLARE account_row record;
BEGIN
  FOR account_row IN SELECT id FROM community_accounts WHERE uid IS NULL ORDER BY id LOOP
    UPDATE community_accounts SET uid=galaxy_new_account_uid_v1() WHERE id=account_row.id;
  END LOOP;
END;
$$;
ALTER TABLE community_accounts ALTER COLUMN uid SET DEFAULT galaxy_new_account_uid_v1();
ALTER TABLE community_accounts ALTER COLUMN uid SET NOT NULL;
ALTER TABLE community_accounts ADD CONSTRAINT community_account_uid_format CHECK(uid ~ '^G[A-Z0-9]{10}[0-9]$');
ALTER TABLE community_accounts ADD CONSTRAINT community_account_uid_unique UNIQUE(uid);

CREATE FUNCTION galaxy_account_uid_immutable_v1() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.uid IS DISTINCT FROM OLD.uid THEN
    RAISE EXCEPTION 'account_uid_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER community_account_uid_immutable BEFORE UPDATE OF uid ON community_accounts
FOR EACH ROW EXECUTE FUNCTION galaxy_account_uid_immutable_v1();

INSERT INTO official_account_profiles_v1(account_id,subject_type,display_name,updated_at)
  SELECT id,NULL,uid,now() FROM community_accounts
  ON CONFLICT(account_id) DO NOTHING;
UPDATE official_account_profiles_v1 p SET display_name=a.uid
  FROM community_accounts a WHERE p.account_id=a.id AND btrim(coalesce(p.display_name,''))='';
`;
