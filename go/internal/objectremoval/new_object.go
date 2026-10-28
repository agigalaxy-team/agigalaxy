package objectremoval

import (
	"context"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RegisterNewObjectWithin is called only in the transaction which has just
// inserted the owning source for the first time, before any upload or removal.
// Replays and existing rows cannot establish this positive unsent observation.
// The receipt permits no removal until the owning domain later qualifies it.
func (s *Service) RegisterNewObjectWithin(ctx context.Context, tx pgx.Tx, d Descriptor) error {
	fingerprint, e := descriptorFingerprint(d)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO galaxy_go_storage.object_removals_v1(endpoint,domain,object_id,operation_id,object_fingerprint,state,created_at,checked_at) VALUES($1,$2,$3,$4,$5,'not-dispatched',$6,$6)`, s.Endpoint, d.Domain, d.ObjectID, uuid.NewString(), fingerprint, s.now())
	return e
}
