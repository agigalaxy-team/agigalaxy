ALTER TABLE task_comments_v2 ALTER COLUMN subject_id DROP NOT NULL;
ALTER TABLE task_comments_v2 ADD CONSTRAINT task_comments_v2_author_check CHECK (subject_id IS NOT NULL OR account_id IS NOT NULL);
ALTER TABLE task_comment_events_v2 ALTER COLUMN subject_id DROP NOT NULL;
ALTER TABLE task_comment_events_v2 ALTER COLUMN consent_id DROP NOT NULL;
ALTER TABLE task_comment_events_v2 ADD COLUMN account_id uuid REFERENCES community_accounts(id);
ALTER TABLE task_comment_events_v2 ADD CONSTRAINT task_comment_events_v2_author_check CHECK ((subject_id IS NOT NULL AND consent_id IS NOT NULL AND account_id IS NULL) OR (subject_id IS NULL AND consent_id IS NULL AND account_id IS NOT NULL));
ALTER TABLE lifecycle_erasure_records ALTER COLUMN subject_id DROP NOT NULL;

ALTER TABLE comment_governance_events_v2 ALTER COLUMN subject_id DROP NOT NULL;
ALTER TABLE comment_governance_events_v2 ALTER COLUMN consent_id DROP NOT NULL;
ALTER TABLE comment_governance_events_v2 ADD COLUMN account_id uuid REFERENCES community_accounts(id);
ALTER TABLE comment_governance_events_v2 ADD CONSTRAINT comment_governance_events_v2_author_check CHECK ((subject_id IS NOT NULL AND consent_id IS NOT NULL AND account_id IS NULL) OR (subject_id IS NULL AND consent_id IS NULL AND (account_id IS NOT NULL OR (erased_at IS NOT NULL AND payload_text=''))));
