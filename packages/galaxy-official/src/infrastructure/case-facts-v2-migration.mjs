// Append this SQL as one new migration; never rewrite v4 or existing events.
export const caseFactsV2MigrationSql = `
ALTER TABLE case_events DROP CONSTRAINT case_events_kind_check;
ALTER TABLE case_events ADD CONSTRAINT case_events_kind_check CHECK (kind IN (
  'case','attempt','result','revision','withdrawal',
  'case-created','attempt-start','attempt-end','attempt-correct','intervention','intervention-response',
  'result-recorded','resolution-recorded','case-scope-revised','case-withdrawn'
));
CREATE TABLE case_task_links (
  task_id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases(id),
  operation_id uuid NOT NULL UNIQUE,
  subject_id text NOT NULL REFERENCES subjects(id),
  payload_hash text NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX case_task_links_case ON case_task_links(case_id);
`;
