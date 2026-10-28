
CREATE TABLE capsules (
  id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE capsule_events (
  id uuid PRIMARY KEY,capsule_id uuid NOT NULL REFERENCES capsules(id),subject_id text NOT NULL REFERENCES subjects(id),
  revision integer NOT NULL,version_id uuid NOT NULL,kind text NOT NULL,
  consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(capsule_id,revision)
);
CREATE TABLE capsule_uses (
  id uuid PRIMARY KEY,capsule_id uuid NOT NULL REFERENCES capsules(id),version_id uuid NOT NULL REFERENCES capsule_events(id),
  subject_id text NOT NULL REFERENCES subjects(id),case_id uuid NOT NULL REFERENCES cases(id),
  attempt_id uuid REFERENCES case_events(id),result_id uuid REFERENCES case_events(id),prior_use_id uuid REFERENCES capsule_uses(id),
  kind text NOT NULL CHECK(kind IN ('reference','apply','reverify')),observed_revision integer NOT NULL,
  consent_id uuid NOT NULL REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),UNIQUE NULLS NOT DISTINCT(version_id,case_id,kind,result_id)
);
CREATE INDEX capsule_owner ON capsules(subject_id,id);
CREATE INDEX capsule_use_case ON capsule_uses(case_id,id);
ALTER TABLE notification_reads DROP CONSTRAINT notification_reads_kind_check;
ALTER TABLE notification_reads ADD CONSTRAINT notification_reads_kind_check CHECK(kind IN ('assistance','context','context-accept','capsule'));
