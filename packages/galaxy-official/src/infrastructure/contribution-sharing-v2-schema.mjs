// Migration58. Publication does not rewrite the original event or Consent.
export const contributionSharingV2MigrationSql=`
CREATE TABLE contribution_publications(
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),consent_id uuid NOT NULL REFERENCES consents(id),
 source_refs jsonb NOT NULL,payload_text text NOT NULL,payload_hash text NOT NULL,
 revoked_at timestamptz,revoke_id uuid UNIQUE,revoke_consent_id uuid REFERENCES consents(id),revoke_payload_text text,revoke_payload_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((revoked_at IS NULL AND revoke_id IS NULL AND revoke_consent_id IS NULL AND revoke_payload_text IS NULL AND revoke_payload_hash IS NULL)
 OR(revoked_at IS NOT NULL AND revoke_id IS NOT NULL AND revoke_consent_id IS NOT NULL AND revoke_payload_text IS NOT NULL AND revoke_payload_hash IS NOT NULL))
);
CREATE INDEX contribution_publication_owner ON contribution_publications(subject_id,id);
CREATE INDEX contribution_publication_sources ON contribution_publications USING gin(source_refs);
`;
