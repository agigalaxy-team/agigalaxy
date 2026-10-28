
CREATE TABLE ci_requests_v2 (
 id uuid PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects(id), consent_id uuid NOT NULL REFERENCES consents(id),
 case_id uuid NOT NULL REFERENCES cases(id), evidence_id uuid NOT NULL, evidence_version integer NOT NULL CHECK(evidence_version>0),
 result_id uuid NOT NULL, result_version integer NOT NULL CHECK(result_version>0),
 source_key text NOT NULL, payload_text text NOT NULL, payload_hash text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','observed','unavailable','revoked')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ci_requests_v2_subject ON ci_requests_v2(subject_id,id);
CREATE INDEX ci_requests_v2_binding ON ci_requests_v2(evidence_id,evidence_version,result_id,result_version);
CREATE TABLE ci_observations_v2 (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES ci_requests_v2(id), job_id uuid NOT NULL REFERENCES jobs(id),
 attempt integer NOT NULL CHECK(attempt>0), observation jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(job_id,attempt)
);
CREATE INDEX ci_observations_v2_request ON ci_observations_v2(request_id,created_at,id);
CREATE TABLE ci_proofs_v2 (
 id uuid PRIMARY KEY, subject_id text NOT NULL REFERENCES subjects(id), request_id uuid NOT NULL REFERENCES ci_requests_v2(id),
 observation_id uuid NOT NULL REFERENCES ci_observations_v2(id), consent_id uuid NOT NULL REFERENCES consents(id),
 payload_text text NOT NULL, payload_hash text NOT NULL, signed text NOT NULL, revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ci_proofs_v2_request ON ci_proofs_v2(request_id,id);
