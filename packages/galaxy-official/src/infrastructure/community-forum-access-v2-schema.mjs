export const communityForumAccessV2MigrationSql=`
CREATE TABLE forum_sections_v2(
 id uuid PRIMARY KEY,maintainer_account_id uuid NOT NULL REFERENCES community_accounts(id),
 creator_subject_id text REFERENCES subjects(id),version integer NOT NULL CHECK(version>0),
 title text NOT NULL,theme text NOT NULL,description text NOT NULL,audience jsonb NOT NULL,
 category text NOT NULL DEFAULT 'unclassified' CHECK(category IN ('technology','arts','learning','life','galaxy','unclassified')),
 state text NOT NULL CHECK(state IN ('active','archived')),created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE forum_section_events_v2(
 id uuid PRIMARY KEY,section_id uuid NOT NULL REFERENCES forum_sections_v2(id),account_id uuid REFERENCES community_accounts(id),subject_id text REFERENCES subjects(id),
 actor_kind text NOT NULL CHECK(actor_kind IN ('identity','official-account')),kind text NOT NULL CHECK(kind IN ('create','update','classification')),
 version integer NOT NULL,consent_id uuid REFERENCES consents(id),payload_text text NOT NULL,payload_hash text NOT NULL,result jsonb NOT NULL,
 http_request_id uuid,created_at timestamptz NOT NULL,UNIQUE(section_id,version));
ALTER TABLE forum_versions_v1 ADD COLUMN section_id uuid REFERENCES forum_sections_v2(id);
ALTER TABLE forum_versions_v1 ADD COLUMN audience jsonb;
ALTER TABLE forum_replies_v1 ADD COLUMN section_id uuid REFERENCES forum_sections_v2(id);
ALTER TABLE forum_replies_v1 ADD COLUMN audience jsonb;
ALTER TABLE forum_replies_v1 ADD COLUMN audience_inherited boolean NOT NULL DEFAULT false;
ALTER TABLE forum_replies_v1 ADD COLUMN parent_audience jsonb NOT NULL DEFAULT '[]';
CREATE TABLE forum_notification_reads_v2(
 account_id uuid NOT NULL REFERENCES community_accounts(id),reply_id uuid NOT NULL REFERENCES forum_replies_v1(id) ON DELETE CASCADE,
 read_at timestamptz NOT NULL,PRIMARY KEY(account_id,reply_id));
CREATE INDEX forum_sections_owner_v2 ON forum_sections_v2(maintainer_account_id,id);
CREATE INDEX forum_versions_section_v2 ON forum_versions_v1(section_id,post_id,id);
CREATE INDEX forum_sections_category_v2 ON forum_sections_v2(category,id);
`;
