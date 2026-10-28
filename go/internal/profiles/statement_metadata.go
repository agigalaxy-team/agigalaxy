package profiles

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"time"
)

// StatementMetadataWithin is the original Discovery source metadata lookup.
// The caller first obtains this statement ID from ReadWithin's currently
// authorized selfDeclaredSource. Metadata alone confers no content permission.
func (s *Service) StatementMetadataWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	var revision int64
	var created time.Time
	e := tx.QueryRow(ctx, `SELECT revision,created_at FROM profile_statements WHERE id=$1`, id).Scan(&revision, &created)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	return Object{"revision": revision, "created_at": created}, nil
}
