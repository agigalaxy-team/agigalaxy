package watchcontrol

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"time"
)

func at(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t.Truncate(time.Millisecond)
	}
	if s, ok := v.(string); ok {
		t, _ := time.Parse(time.RFC3339Nano, s)
		return t.Truncate(time.Millisecond)
	}
	return time.Time{}
}
func (s *Service) Get(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "read")
	if e != nil {
		return nil, e
	}
	p := x.Values()
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		row, e := s.own(ctx, tx, a, text(p, "watchId"))
		if e != nil {
			return nil, e
		}
		view, e := s.view(ctx, tx, a, row)
		if e != nil {
			return nil, e
		}
		return Object{"watch": view}, nil
	})
}
func (s *Service) Query(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "query")
	if e != nil {
		return nil, e
	}
	p := x.Values()
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		rows, e := query(ctx, tx, `SELECT * FROM watch_controls_v2 WHERE subject_id=$1 AND($2::uuid IS NULL OR watch_id>$2) ORDER BY watch_id LIMIT $3`, a.SubjectID, p["after"], number(p, "limit")+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		end := len(rows)
		if end > int(number(p, "limit")) {
			end = int(number(p, "limit"))
		}
		for _, row := range rows[:end] {
			view, e := s.view(ctx, tx, a, row)
			if e != nil {
				return nil, e
			}
			items = append(items, view)
		}
		var next any
		if len(rows) > end {
			next = obj(items[len(items)-1])["watchId"]
		}
		return Object{"items": items, "next": next, "scope": "own-explicitly-registered-controls; local-only-watches-not-uploaded", "cloudModel": false}, nil
	})
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	x, e := parse(raw, "receipt")
	if e != nil {
		return nil, e
	}
	p := x.Values()
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		row, e := one(ctx, tx, `SELECT * FROM watch_control_operations_v2 WHERE operation_id=$1 AND subject_id=$2`, p["operationId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if row == nil {
			return Object{"operationId": p["operationId"], "state": "absent"}, nil
		}
		if row["request_hash"] != p["requestHash"] {
			return nil, fault.New("watch_operation_conflict", 409)
		}
		return s.response(ctx, tx, a, row)
	})
}

// PurgeExpiredWithin retains the original bounded 90-day control metadata
// cleanup; it starts no scheduler and does not erase chat bodies or host state.
func (s *Service) PurgeExpiredWithin(ctx context.Context, tx pgx.Tx) (Object, error) {
	rows, e := query(ctx, tx, `SELECT watch_id FROM watch_controls_v2 WHERE COALESCE(stopped_at,expires_at)<=$1 ORDER BY watch_id LIMIT 100`, time.Unix(s.now()-90*86400, 0))
	if e != nil {
		return nil, e
	}
	ids := []string{}
	for _, r := range rows {
		ids = append(ids, text(r, "watch_id"))
	}
	if len(ids) > 0 {
		if _, e = tx.Exec(ctx, `DELETE FROM watch_control_operations_v2 WHERE watch_id=ANY($1::uuid[])`, ids); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `DELETE FROM watch_controls_v2 WHERE watch_id=ANY($1::uuid[])`, ids); e != nil {
			return nil, e
		}
	}
	return Object{"watchControlReceipts": len(ids)}, nil
}
