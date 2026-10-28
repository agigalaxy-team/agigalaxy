package discovery

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type Worker struct{ Runtime *Runtime }

func (w *Worker) SeedBatch(ctx context.Context, limit int) (Object, error) {
	s := w.Runtime.Store
	var after string
	if e := s.Pool.QueryRow(ctx, "SELECT scan_after FROM discovery_index_control_v1 WHERE endpoint=$1", s.Endpoint).Scan(&after); e != nil {
		return nil, e
	}
	rows, e := w.Runtime.Source.Candidates(ctx, after, limit)
	if e != nil {
		return nil, e
	}
	queued := 0
	for _, r := range rows {
		changed, e := s.Reconcile(ctx, r)
		if e != nil {
			return nil, e
		}
		if changed {
			queued++
		}
	}
	complete := len(rows) < limit
	last := ""
	if !complete && len(rows) > 0 {
		r := rows[len(rows)-1]
		last = r.Kind + ":" + r.ID
	}
	_, e = s.Pool.Exec(ctx, "UPDATE discovery_index_control_v1 SET scan_after=$2,scan_complete=$3,updated_at=$4 WHERE endpoint=$1", s.Endpoint, last, complete, s.now())
	if e != nil {
		return nil, e
	}
	return Object{"queued": queued, "scanned": len(rows), "complete": complete}, nil
}
func (w *Worker) IndexOne(ctx context.Context) (Object, error) {
	r := w.Runtime
	if r.Meili == nil || r.Gorse == nil {
		return Object{"state": "not-connected"}, nil
	}
	if e := r.Store.QueueExpired(ctx, 100); e != nil {
		return nil, e
	}
	claim, e := r.Store.ClaimIndex(ctx)
	if e != nil {
		return nil, e
	}
	if claim == nil {
		return Object{"state": "idle"}, nil
	}
	result, e := w.applyIndex(ctx, *claim)
	if e != nil {
		code := fault.Code(e)
		if code == "internal_error" {
			code = "discovery_worker_failed"
		}
		if settle := r.Store.CompleteIndex(ctx, *claim, nil, nil, &code); settle != nil {
			return nil, settle
		}
		return Object{"state": "failed", "code": code}, nil
	}
	return result, nil
}
func (w *Worker) applyIndex(ctx context.Context, claim IndexClaim) (Object, error) {
	r := w.Runtime
	reference := claim.Reference
	document, e := r.Source.Load(ctx, reference)
	if e != nil {
		return nil, e
	}
	key, _ := ItemKey(reference)
	if document != nil {
		if e = r.Meili.Upsert(ctx, *document); e != nil {
			return nil, e
		}
		current, e := r.Source.Load(ctx, reference)
		if e != nil {
			return nil, e
		}
		if current == nil || current.IndexVersion != document.IndexVersion {
			if e = r.Meili.Remove(ctx, key); e != nil {
				return nil, e
			}
			if e = r.Gorse.Remove(ctx, key); e != nil {
				return nil, e
			}
			if e = r.Store.Enqueue(ctx, reference); e != nil {
				return nil, e
			}
			if e = r.Store.CompleteIndex(ctx, claim, nil, nil, nil); e != nil {
				return nil, e
			}
			return Object{"state": "source-changed"}, nil
		}
		if e = r.Gorse.Upsert(ctx, *current); e != nil {
			return nil, e
		}
		if e = r.Store.CompleteIndex(ctx, claim, &document.Version, &current.PublishedUntil, nil); e != nil {
			return nil, e
		}
		return Object{"state": "indexed", "kind": reference.Kind, "id": reference.ID}, nil
	}
	if e = r.Meili.Remove(ctx, key); e != nil {
		return nil, e
	}
	if e = r.Gorse.Remove(ctx, key); e != nil {
		return nil, e
	}
	if e = r.Store.CompleteIndex(ctx, claim, nil, nil, nil); e != nil {
		return nil, e
	}
	return Object{"state": "removed", "kind": reference.Kind, "id": reference.ID}, nil
}
