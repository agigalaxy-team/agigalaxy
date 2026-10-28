package taskmaterials

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

const outcomeCleanupQualification = `m.purged_at IS NULL AND (m.purge_pending OR m.expires_at<=$1 OR (m.state='requested' AND m.request_expires_at<=$1) OR EXISTS(SELECT 1 FROM cases c WHERE c.id=m.case_id AND c.state='withdrawn') OR EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id IN(m.subject_id,m.author_id) AND d.state IN ('approved','partial','primary-erased')))`

func (o *OutcomeService) cleanupCopyWithin(ctx context.Context, tx pgx.Tx, id string, at int64) (Object, error) {
	return row(ctx, tx, `SELECT to_jsonb(m) FROM outcome_materials_v2 m WHERE `+outcomeCleanupQualification+` AND m.id=$2 FOR UPDATE`, stamp(at), id)
}

func (o *OutcomeService) purgeCopies(ctx context.Context, limit int) (Object, error) {
	return o.purgeCopiesForSubject(ctx, "", limit)
}

// PurgeSubjectCopies reconciles only the approved subject's own/source-author
// copies. The caller retains the original approved deletion intent boundary.
func (o *OutcomeService) PurgeSubjectCopies(ctx context.Context, subject string, limit int) (Object, error) {
	if subject == "" || limit < 1 || limit > 1000 {
		return nil, fail("invalid_outcome_material_request", 400)
	}
	return o.purgeCopiesForSubject(ctx, subject, limit)
}
func (o *OutcomeService) purgeCopiesForSubject(ctx context.Context, subject string, limit int) (Object, error) {
	ids, e := postgres.InTx(ctx, o.Pool, func(tx pgx.Tx) ([]Object, error) {
		return rows(ctx, tx, `SELECT jsonb_build_object('id',m.id) FROM outcome_materials_v2 m WHERE `+outcomeCleanupQualification+` AND ($3='' OR m.subject_id=$3 OR m.author_id=$3) ORDER BY m.created_at,m.id LIMIT $2`, stamp(o.now()), limit, subject)
	})
	if e != nil {
		return nil, e
	}
	erased := 0
	for _, candidate := range ids {
		id := str(candidate, "id")
		removals := o.removalService()
		var claim *objectremoval.Reservation
		_, e = postgres.InTx(ctx, o.Pool, func(tx pgx.Tx) (bool, error) {
			m, e := o.cleanupCopyWithin(ctx, tx, id, o.now())
			if e != nil || m == nil {
				return false, e
			}
			if str(m, "storage_key") == "" {
				return false, nil
			}
			if !objectremoval.Capable(o.Store) {
				return false, fail("outcome_material_storage_unavailable", 503)
			}
			d := outcomeRemovalDescriptor(m)
			status, e := removals.StatusWithin(ctx, tx, d)
			if e != nil {
				return false, e
			}
			// Only the owning INSERT's persisted not-dispatched fact can permit
			// a first dispatch. Existing reserved/unknown copies are HEAD-only.
			claim, e = removals.ReserveWithin(ctx, tx, d, status.State == "not-recorded")
			return true, e
		})
		if e != nil {
			return nil, e
		}
		var external error
		removed, e := postgres.InTx(ctx, o.Pool, func(tx pgx.Tx) (bool, error) {
			m, e := o.cleanupCopyWithin(ctx, tx, id, o.now())
			if e != nil {
				return false, e
			}
			if m == nil {
				if claim != nil {
					_, e = removals.NotDispatchedWithin(ctx, tx, claim, "")
				}
				return false, e
			}
			if str(m, "storage_key") != "" {
				status, e := removals.ResolveWithin(ctx, tx, o.Store, outcomeRemovalDescriptor(m), claim)
				if e != nil && status.State == "" {
					return false, e
				}
				external = e
				if !status.ObjectRemoved {
					return false, nil
				}
			}
			_, e = tx.Exec(ctx, "UPDATE outcome_materials_v2 SET state='erased',body_text='',name='',media_type='',storage_key=NULL,encryption_key_id=NULL,purge_pending=false,purged_at=$2 WHERE id=$1", id, stamp(o.now()))
			return e == nil, e
		})
		if e != nil {
			return nil, e
		}
		if removed {
			erased++
		}
		if external != nil {
			return Object{"outcomeMaterialCopiesErased": erased, "externalCopiesErased": false}, external
		}
	}
	return Object{"outcomeMaterialCopiesErased": erased, "externalCopiesErased": false}, nil
}
