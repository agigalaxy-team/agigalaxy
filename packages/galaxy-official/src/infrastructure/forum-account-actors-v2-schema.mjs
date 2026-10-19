// Ordinary website accounts retain their own authorship and HTTP authorization.
// They never receive a fabricated Galaxy subject, binding or Consent signature.
export const forumAccountActorsV2MigrationSql=`
ALTER TABLE forum_permissions_v1 ADD COLUMN authorization_kind text NOT NULL DEFAULT 'id-consent'
 CHECK(authorization_kind IN ('id-consent','official-account'));
ALTER TABLE forum_permissions_v1 ALTER COLUMN accepted_epoch DROP NOT NULL;
ALTER TABLE forum_permissions_v1 ALTER COLUMN signer_public_key DROP NOT NULL;
ALTER TABLE forum_permissions_v1 ALTER COLUMN signature_hash DROP NOT NULL;
ALTER TABLE forum_permissions_v1 ADD CONSTRAINT forum_account_permission_source_v2 CHECK(
 authorization_kind='id-consent' OR
 (subject_id IS NULL AND consent_id IS NULL AND origin_binding_id IS NULL AND source_device_id IS NULL AND source_key_id IS NULL
  AND accepted_epoch IS NULL AND accepted_control_hash IS NULL AND signer_public_key IS NULL AND signature_hash IS NULL));
ALTER TABLE forum_events_v1 ADD COLUMN actor_kind text NOT NULL DEFAULT 'identity' CHECK(actor_kind IN ('identity','official-account'));
ALTER TABLE forum_events_v1 ADD COLUMN http_request_id uuid;
ALTER TABLE forum_write_receipts_v1 ADD COLUMN actor_kind text NOT NULL DEFAULT 'identity' CHECK(actor_kind IN ('identity','official-account'));
CREATE INDEX forum_posts_account_owner_v2 ON forum_posts_v1(account_id,created_at DESC,id DESC);
CREATE INDEX forum_replies_account_owner_v2 ON forum_replies_v1(account_id,id);
CREATE INDEX forum_receipts_account_owner_v2 ON forum_write_receipts_v1(account_id,operation_id);
`;
