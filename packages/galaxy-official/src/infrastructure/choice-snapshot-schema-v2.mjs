export const choiceSnapshotV2MigrationSql=`
CREATE TABLE choice_snapshot_preferences (
 subject_id text PRIMARY KEY, revision integer NOT NULL DEFAULT 0, endpoint text NOT NULL, enabled boolean NOT NULL DEFAULT false,
 snapshot_ids jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL
);
CREATE TABLE choice_snapshot_heads (
 subject_id text NOT NULL, snapshot_id uuid NOT NULL, revision integer NOT NULL DEFAULT 0,current_version_id uuid,
 deleted_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,PRIMARY KEY(subject_id,snapshot_id)
);
CREATE TABLE choice_snapshot_versions (
 subject_id text NOT NULL,snapshot_id uuid NOT NULL,version_id uuid NOT NULL,base_revision integer NOT NULL,revision integer NOT NULL,
 request_hash text NOT NULL,state text NOT NULL CHECK(state IN ('current','conflict','superseded','expired','deleted','invalidated')),
 content jsonb NOT NULL,dependencies jsonb NOT NULL,created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 PRIMARY KEY(subject_id,version_id),FOREIGN KEY(subject_id,snapshot_id) REFERENCES choice_snapshot_heads(subject_id,snapshot_id)
);
CREATE INDEX choice_snapshot_versions_owner ON choice_snapshot_versions(subject_id,snapshot_id,revision);
CREATE INDEX choice_snapshot_versions_expiry ON choice_snapshot_versions(expires_at) WHERE state IN ('current','conflict');
`;
