package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (f *SharedSummaryService) PurgeExpired(ctx context.Context, limit int) (Object, error) {
	if limit < 1 || limit > 1000 {
		return nil, sharedError()
	}
	return postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		rr, e := rows(ctx, tx, "SELECT to_jsonb(s) FROM room_shared_summaries s WHERE state IN ('pending','published') AND expires_at<=$1 ORDER BY share_id LIMIT $2 FOR UPDATE", f.Chat.now(), limit)
		if e != nil {
			return nil, e
		}
		for _, r := range rr {
			if _, e = f.reconcile(ctx, tx, r); e != nil {
				return nil, e
			}
		}
		return Object{"expiredShares": len(rr)}, nil
	})
}
func (f *SharedSummaryService) PurgeInvalidSources(ctx context.Context, after string, limit int) (Object, error) {
	if after != "" && !validID(after) || limit < 1 || limit > 100 {
		return nil, sharedError()
	}
	return postgres.InTx(ctx, f.Chat.Pool, func(tx pgx.Tx) (Object, error) {
		rr, e := rows(ctx, tx, "SELECT to_jsonb(s) FROM room_shared_summaries s WHERE state IN ('pending','published') AND ($1::uuid IS NULL OR share_id>$1) ORDER BY share_id LIMIT $2 FOR UPDATE", null(after), limit+1)
		if e != nil {
			return nil, e
		}
		changed, checked := 0, 0
		for i, r := range rr {
			if i >= limit {
				break
			}
			checked++
			oldState := str(r, "state")
			reconciled, e := f.reconcile(ctx, tx, r)
			if e != nil {
				return nil, e
			}
			if str(reconciled, "state") != oldState {
				changed++
				continue
			}
			filtered, e := f.filter(ctx, tx, nil, str(r, "room_id"), obj(r, "content"), true)
			if e != nil {
				return nil, e
			}
			if filtered.StorageChanged {
				facts := summaryFacts(r["source_facts"], filtered.Persisted)
				if _, e = tx.Exec(ctx, "UPDATE room_shared_summaries SET content=$2,source_facts=$3 WHERE share_id=$1", r["share_id"], encode(filtered.Persisted), encode(facts)); e != nil {
					return nil, e
				}
				changed++
			}
		}
		var next any
		if len(rr) > limit {
			next = rr[limit-1]["share_id"]
		}
		return Object{"checked": checked, "changed": changed, "nextAfter": next}, nil
	})
}
