export const outcomeMaterialV2MigrationSql=`
CREATE TABLE outcome_materials_v2(
 id uuid PRIMARY KEY,subject_id text NOT NULL REFERENCES subjects(id),author_id text NOT NULL,
 case_id uuid NOT NULL,task_id uuid,source jsonb NOT NULL,source_kind text NOT NULL CHECK(source_kind IN('message','attachment')),
 audience jsonb NOT NULL DEFAULT '{"visibility":"Private","viewers":[]}'::jsonb,
 uses jsonb NOT NULL DEFAULT '[]'::jsonb,title text NOT NULL DEFAULT '',
 request_id uuid NOT NULL,approval_id uuid,revision integer NOT NULL DEFAULT 1,
 state text NOT NULL CHECK(state IN('requested','copying','available','copy-failed','declined','cancelled','revoked','erased')),
 created_at timestamptz NOT NULL,request_expires_at timestamptz NOT NULL,approved_at timestamptz,expires_at timestamptz,
 body_text text NOT NULL DEFAULT '',name text NOT NULL DEFAULT '',media_type text NOT NULL DEFAULT '',
 byte_size bigint NOT NULL DEFAULT 0,sha256 text NOT NULL,storage_key text,encryption_key_id text,scan_result jsonb,
 lease_id uuid,lease_until timestamptz,last_error text,purge_pending boolean NOT NULL DEFAULT false,purged_at timestamptz
);
CREATE INDEX outcome_material_owner_page ON outcome_materials_v2(subject_id,id);
CREATE INDEX outcome_material_author_page ON outcome_materials_v2(author_id,id);
CREATE TABLE outcome_material_events_v2(
 id uuid PRIMARY KEY,material_id uuid NOT NULL REFERENCES outcome_materials_v2(id),subject_id text NOT NULL,
 kind text NOT NULL,revision integer NOT NULL,consent_id uuid NOT NULL,payload_text text NOT NULL,payload_hash text NOT NULL,
 created_at timestamptz NOT NULL
);
CREATE INDEX outcome_material_events ON outcome_material_events_v2(material_id,revision);
`;
