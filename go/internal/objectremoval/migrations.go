package objectremoval

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// MigrateWithin is an explicit administrative migration. Runtime construction
// never creates this ledger or adopts an existing deletion as a new attempt.
func MigrateWithin(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `CREATE SCHEMA IF NOT EXISTS galaxy_go_storage;
 REVOKE ALL ON SCHEMA galaxy_go_storage FROM PUBLIC;
 CREATE TABLE IF NOT EXISTS galaxy_go_storage.object_removals_v1(
 endpoint text NOT NULL, domain text NOT NULL CHECK(domain IN('chat','forum','outcome')),
 object_id uuid NOT NULL, operation_id uuid,
 object_fingerprint text NOT NULL CHECK(object_fingerprint ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN('reserved','not-dispatched','result-unknown','absent','legacy-unknown')),
 created_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz, last_error text,
 PRIMARY KEY(endpoint,domain,object_id),
 CHECK(operation_id IS NOT NULL OR state IN('legacy-unknown','absent')),
 CHECK((state='absent')=(completed_at IS NOT NULL))
 );
 ALTER TABLE galaxy_go_storage.object_removals_v1 DROP CONSTRAINT IF EXISTS object_removals_v1_state_check;
 ALTER TABLE galaxy_go_storage.object_removals_v1 ADD CONSTRAINT object_removals_v1_state_check
 CHECK(state IN('reserved','not-dispatched','result-unknown','absent','legacy-unknown'));
 REVOKE ALL ON galaxy_go_storage.object_removals_v1 FROM PUBLIC;`)
	return err
}

// Source identity columns and original operation relations are immutable to
// runtime roles. Only the outcome of that same removal may be updated.
func ProvisionRolesWithin(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `GRANT USAGE ON SCHEMA galaxy_go_storage TO galaxy_api,galaxy_evidence_worker;
 GRANT SELECT,INSERT ON galaxy_go_storage.object_removals_v1 TO galaxy_api,galaxy_evidence_worker;
 GRANT UPDATE(state,checked_at,completed_at,last_error) ON galaxy_go_storage.object_removals_v1 TO galaxy_api,galaxy_evidence_worker;`)
	return err
}
