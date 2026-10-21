export const contentPublicationsV1MigrationSql=`
CREATE TABLE site_publications_v1 (
  sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,requested_by text NOT NULL,
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=1048576),
  state text NOT NULL CHECK(state IN ('queued','building','published','failed')),
  job_id uuid,attempts integer NOT NULL DEFAULT 0,result jsonb,error jsonb,
  created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,published_at timestamptz
);
CREATE INDEX site_publications_page ON site_publications_v1(endpoint,sequence DESC);
`;

