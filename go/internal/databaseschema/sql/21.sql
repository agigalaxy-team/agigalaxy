
CREATE TABLE recovery_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), recovery_id uuid NOT NULL,
  snapshot_id text NOT NULL,status text NOT NULL CHECK(status IN ('quarantined','ready')),
  created_at timestamptz NOT NULL DEFAULT now(),activated_at timestamptz
);
