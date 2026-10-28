package publication

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

// CancelJobWithin is the original owning cancellation consumer. The caller
// must have checked both queue and cms.publish authority and verified the
// stored job's source in this transaction. Transport cancellation follows in
// that same transaction; this method never claims to undo an activated site.
func (c *Commands) CancelJobWithin(ctx context.Context, tx pgx.Tx, sourceID string) error {
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(734912341)"); e != nil {
		return e
	}
	r, e := readRow(ctx, tx, sourceID, c.Endpoint, true)
	if errors.Is(e, pgx.ErrNoRows) {
		return fault.New("site_publication_not_found", 404)
	}
	if e != nil {
		return e
	}
	if r.State == "published" || truthyValue(r.Result["activationPending"]) || terminal(r) && r.Error["code"] != "site_publication_cancelled" {
		return fault.New("site_publication_not_cancellable", 409)
	}
	failure, e := json.Marshal(Object{"code": "site_publication_cancelled", "message": "已取消发布。", "retryable": false})
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, "UPDATE site_publications_v1 SET state='failed',error=$2,updated_at=$3 WHERE id=$1", r.ID, failure, c.now())
	return e
}
