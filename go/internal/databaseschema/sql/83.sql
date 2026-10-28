
CREATE TABLE reading_bookmarks_v1(
 id uuid PRIMARY KEY,
 subject_id text NOT NULL REFERENCES subjects(id),
 reference_key text NOT NULL,
 reference jsonb NOT NULL,
 saved boolean NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 created_at timestamptz NOT NULL,
 saved_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(subject_id,reference_key)
);
CREATE INDEX reading_bookmarks_owner_v1 ON reading_bookmarks_v1(subject_id,saved,saved_at DESC,id DESC);
CREATE TABLE reading_bookmark_operations_v1(
 subject_id text NOT NULL REFERENCES subjects(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL CHECK(request_hash~'^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(subject_id,operation_id)
);
