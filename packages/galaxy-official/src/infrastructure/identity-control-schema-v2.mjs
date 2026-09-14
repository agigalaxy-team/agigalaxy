// Append-only migration. Genesis fields and historical signatures are untouched.
export const identityControlMigrationSql = `
CREATE TABLE subject_control_heads (
  subject_id text PRIMARY KEY REFERENCES subjects(id), epoch integer NOT NULL CHECK(epoch>0),
  sequence integer NOT NULL CHECK(sequence>0), event_hash text NOT NULL
);
CREATE TABLE subject_control_events (
  id uuid PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects(id), sequence integer NOT NULL,
  epoch integer NOT NULL, kind text NOT NULL, previous_event_hash text, event_hash text NOT NULL UNIQUE,
  payload_text text NOT NULL, controller_signature text NOT NULL, new_device_proof text,
  signer_key_id text NOT NULL, accepted_at timestamptz NOT NULL, UNIQUE(subject_id,sequence)
);
CREATE TABLE device_authorizations (
  device_id uuid PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects(id), key_id text NOT NULL,
  public_key text NOT NULL, epoch integer NOT NULL, scopes jsonb NOT NULL,
  status text NOT NULL CHECK(status IN ('active','revoked')), source_event_id uuid NOT NULL REFERENCES subject_control_events(id),
  revoked_at timestamptz, UNIQUE(subject_id,key_id,epoch)
);
CREATE TABLE recovery_authorizations (
  subject_id text NOT NULL REFERENCES subjects(id), generation integer NOT NULL, epoch integer NOT NULL,
  public_key text NOT NULL, source_event_id uuid NOT NULL REFERENCES subject_control_events(id),
  status text NOT NULL CHECK(status IN ('active','consumed','replaced')),
  save_declared_at timestamptz, PRIMARY KEY(subject_id,generation)
);
CREATE UNIQUE INDEX recovery_authorization_active ON recovery_authorizations(subject_id) WHERE status='active';
CREATE TABLE identity_control_operations (
  id uuid PRIMARY KEY, subject_id text NOT NULL, request_hash text NOT NULL, request jsonb NOT NULL,
  challenge_text text NOT NULL, expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','committed','canceled')),
  receipt jsonb, committed_at timestamptz
);
ALTER TABLE bindings ADD COLUMN device_id uuid REFERENCES device_authorizations(device_id);
ALTER TABLE bindings ADD COLUMN key_id text;
ALTER TABLE bindings ADD COLUMN control_epoch integer;
ALTER TABLE access_credentials ADD COLUMN device_id uuid REFERENCES device_authorizations(device_id);
ALTER TABLE access_credentials ADD COLUMN key_id text;
ALTER TABLE access_credentials ADD COLUMN control_epoch integer;
ALTER TABLE consents ADD COLUMN signature_envelope text;
ALTER TABLE consents ADD COLUMN signed_payload_text text;
ALTER TABLE consents ADD COLUMN signer_key_id text;
ALTER TABLE consents ADD COLUMN control_epoch integer;
ALTER TABLE consents ADD COLUMN control_event_hash text;
ALTER TABLE external_identity_links ADD COLUMN signer_key_id text;
ALTER TABLE external_identity_links ADD COLUMN control_epoch integer;
ALTER TABLE external_identity_links ADD COLUMN control_event_hash text;
ALTER TABLE deletion_events ADD COLUMN signer_public_key text;
ALTER TABLE deletion_events ADD COLUMN signer_control_chain jsonb;
-- Locking must not grant the API permission to rewrite immutable Genesis rows.
CREATE FUNCTION public.galaxy_api_lock_subject_control(owner_id text,exclusive_lock boolean)
RETURNS SETOF public.subjects LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF exclusive_lock THEN
    RETURN QUERY SELECT s.* FROM public.subjects s WHERE s.id=owner_id FOR UPDATE;
  ELSE
    RETURN QUERY SELECT s.* FROM public.subjects s WHERE s.id=owner_id FOR SHARE;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.galaxy_api_lock_subject_control(text,boolean) FROM PUBLIC;
`;
