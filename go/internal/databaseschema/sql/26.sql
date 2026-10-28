
CREATE TABLE deletion_replays (
  id uuid PRIMARY KEY,recovery_id uuid NOT NULL UNIQUE,source_digest text NOT NULL,
  command_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
