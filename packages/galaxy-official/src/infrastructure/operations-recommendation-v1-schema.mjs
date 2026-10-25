// Migration 107: operational mappings/versions and server-issued attribution.
// No semantic model, new retention duration or automatic deletion is enabled.
export const operationsRecommendationV1MigrationSql=`
CREATE TABLE operations_recommendation_policy_v1(
 endpoint text PRIMARY KEY,revision integer NOT NULL CHECK(revision>0),enabled boolean NOT NULL,
 directions jsonb NOT NULL CHECK(jsonb_typeof(directions)='array'),controls jsonb NOT NULL,
 updated_at timestamptz NOT NULL
);
CREATE TABLE operations_recommendation_themes_v1(
 id uuid PRIMARY KEY,endpoint text NOT NULL,label text NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 enabled boolean NOT NULL,revision integer NOT NULL CHECK(revision>0),mapping jsonb NOT NULL,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL
);
CREATE INDEX operations_recommendation_themes_endpoint_v1 ON operations_recommendation_themes_v1(endpoint,label,id);
CREATE TABLE operations_recommendation_events_v1(
 sequence bigserial PRIMARY KEY,id uuid NOT NULL UNIQUE,endpoint text NOT NULL,operator_id text NOT NULL,
 operation_id uuid NOT NULL,request_hash text NOT NULL,kind text NOT NULL CHECK(kind IN ('policy-updated','theme-created','theme-updated')),
 revision integer NOT NULL,theme_key text,changes jsonb NOT NULL,reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 result jsonb NOT NULL,created_at timestamptz NOT NULL,UNIQUE(endpoint,operation_id)
);
CREATE INDEX operations_recommendation_events_history_v1 ON operations_recommendation_events_v1(endpoint,sequence DESC);
CREATE TABLE discovery_recommendation_requests_v1(
 sequence bigserial NOT NULL,endpoint text NOT NULL,id uuid NOT NULL,profile_id text NOT NULL,policy_version integer,
 mode text NOT NULL CHECK(mode IN ('personalized','latest')),placement text NOT NULL CHECK(placement='home-public-recommendations'),
 items jsonb NOT NULL CHECK(jsonb_typeof(items)='array'),created_at timestamptz NOT NULL,PRIMARY KEY(endpoint,id)
);
CREATE INDEX discovery_recommendation_profile_v1 ON discovery_recommendation_requests_v1(endpoint,profile_id,created_at DESC);
`;
export const operationsRecommendationApiGrantsSql=`
GRANT SELECT,INSERT ON operations_recommendation_policy_v1,operations_recommendation_themes_v1 TO galaxy_api;
GRANT UPDATE(revision,enabled,directions,controls,updated_at) ON operations_recommendation_policy_v1 TO galaxy_api;
GRANT UPDATE(label,enabled,revision,mapping,updated_at) ON operations_recommendation_themes_v1 TO galaxy_api;
GRANT SELECT,INSERT ON operations_recommendation_events_v1,discovery_recommendation_requests_v1 TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE operations_recommendation_events_v1_sequence_seq TO galaxy_api;
GRANT USAGE,SELECT ON SEQUENCE discovery_recommendation_requests_v1_sequence_seq TO galaxy_api;
`;
