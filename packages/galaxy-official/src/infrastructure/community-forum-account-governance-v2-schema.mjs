export const communityForumAccountGovernanceV2MigrationSql=`
ALTER TABLE forum_permissions_v1 ADD COLUMN account_viewers jsonb NOT NULL DEFAULT '[]';
ALTER TABLE forum_reports_v1 ADD COLUMN reporter_account_id uuid REFERENCES community_accounts(id);
ALTER TABLE forum_reports_v1 ADD COLUMN target_author_account_id uuid REFERENCES community_accounts(id);
ALTER TABLE forum_reports_v1 ADD COLUMN account_governance boolean NOT NULL DEFAULT false;
UPDATE forum_reports_v1 SET reporter_account_id=account_id;
UPDATE forum_reports_v1 r SET target_author_account_id=v.account_id FROM forum_versions_v1 v
 WHERE r.target->>'kind'='post-version' AND r.target->>'versionId'=v.id::text;
UPDATE forum_reports_v1 r SET target_author_account_id=v.account_id FROM forum_replies_v1 v
 WHERE r.target->>'kind'='reply' AND r.target->>'replyId'=v.id::text;
ALTER TABLE forum_governance_events_v1 ADD COLUMN actor_kind text NOT NULL DEFAULT 'identity' CHECK(actor_kind IN ('identity','official-account'));
ALTER TABLE forum_governance_events_v1 ADD COLUMN http_request_id uuid;
ALTER TABLE lifecycle_erasure_records ALTER COLUMN subject_id DROP NOT NULL;
ALTER TABLE lifecycle_erasure_records ADD COLUMN account_id uuid REFERENCES community_accounts(id);
CREATE INDEX forum_reports_account_parties_v2 ON forum_reports_v1(reporter_account_id,target_author_account_id,id);
`;
