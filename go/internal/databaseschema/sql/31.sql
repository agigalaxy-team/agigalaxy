
ALTER TABLE moderation_reports ALTER COLUMN assistance_id DROP NOT NULL;
ALTER TABLE moderation_reports ADD COLUMN case_id uuid REFERENCES cases(id);
ALTER TABLE moderation_reports ADD CONSTRAINT moderation_exact_target CHECK (
  (assistance_id IS NOT NULL AND case_id IS NULL) OR (assistance_id IS NULL AND case_id IS NOT NULL));
CREATE INDEX moderation_case ON moderation_reports(case_id,paused,id);
