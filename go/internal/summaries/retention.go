package summaries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (s *Service) EraseSubjectWithin(ctx context.Context, tx pgx.Tx, subject string) (Object, error) {
	if _, e := tx.Exec(ctx, "UPDATE personal_summary_preferences SET enabled=false,room_ids=NULL,revision=revision+1 WHERE subject_id=$1", subject); e != nil {
		return nil, e
	}
	r, e := tx.Exec(ctx, "UPDATE personal_summary_versions SET state='deleted',content='{}'::jsonb WHERE subject_id=$1 AND state IN ('current','conflict')", subject)
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, "UPDATE personal_summary_heads SET deleted_at=$2,revision=revision+1 WHERE subject_id=$1 AND deleted_at IS NULL", subject, stamp(s.now())); e != nil {
		return nil, e
	}
	return Object{"erasedVersions": r.RowsAffected(), "localDeleted": false, "remainingMetadata": true}, nil
}
func (s *Service) PurgeExpiredWithin(ctx context.Context, tx pgx.Tx) (Object, error) {
	r, e := tx.Exec(ctx, "UPDATE personal_summary_versions SET state='expired',content='{}'::jsonb WHERE state IN ('current','conflict') AND expires_at<=$1", stamp(s.now()))
	if e != nil {
		return nil, e
	}
	return Object{"expiredVersions": r.RowsAffected()}, nil
}
func (s *Service) PurgeExpired(ctx context.Context) (Object, error) {
	if s == nil || s.Pool == nil {
		return nil, fail("summary_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.PurgeExpiredWithin(ctx, tx) })
}
func (s *Service) PurgeInvalidSources(ctx context.Context, after string, limit int) (Object, error) {
	if s == nil || s.Pool == nil {
		return nil, fail("summary_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.PurgeInvalidSourcesWithin(ctx, tx, after, limit) })
}
func (s *Service) PurgeInvalidSourcesWithin(ctx context.Context, tx pgx.Tx, after string, limit int) (Object, error) {
	if after != "" && !uuidPattern.MatchString(after) || limit < 1 || limit > 100 {
		return nil, fail("invalid_personal_summary_request", 400)
	}
	if s.ErasureSource == nil {
		return nil, fail("summary_erasure_source_authority_unavailable", 503)
	}
	var cursor any
	if after != "" {
		cursor = after
	}
	records, e := rows(ctx, tx, "SELECT to_jsonb(v)||jsonb_build_object('room_id',h.room_id) FROM personal_summary_versions v JOIN personal_summary_heads h ON h.subject_id=v.subject_id AND h.summary_id=v.summary_id WHERE v.state IN ('current','conflict') AND ($1::uuid IS NULL OR v.version_id>$1) ORDER BY v.version_id LIMIT $2", cursor, limit+1)
	if e != nil {
		return nil, e
	}
	changed := 0
	for _, selected := range records[:min(len(records), limit)] {
		if _, e = row(ctx, tx, "SELECT jsonb_build_object('summary_id',summary_id) FROM personal_summary_heads WHERE subject_id=$1 AND summary_id=$2 FOR UPDATE", selected["subject_id"], selected["summary_id"]); e != nil {
			return nil, e
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(v) FROM personal_summary_versions v WHERE subject_id=$1 AND version_id=$2", selected["subject_id"], selected["version_id"])
		if e != nil {
			return nil, e
		}
		if r == nil || (r["state"] != "current" && r["state"] != "conflict") {
			continue
		}
		before, e := digestIntent(r["content"])
		if e != nil {
			return nil, e
		}
		_, e = s.viewWithFilter(ctx, tx, str(r, "subject_id"), r, func(content Object) (filtered, error) {
			return filterContent(content, func(ref Object) (Object, error) {
				q := Object{"roomId": selected["room_id"]}
				for k, v := range ref {
					q[k] = v
				}
				return s.ErasureSource(ctx, tx, str(r, "subject_id"), q)
			})
		})
		if e != nil {
			return nil, e
		}
		stored, e := row(ctx, tx, "SELECT jsonb_build_object('content',content,'state',state) FROM personal_summary_versions WHERE subject_id=$1 AND version_id=$2", r["subject_id"], r["version_id"])
		if e != nil {
			return nil, e
		}
		after, e := digestIntent(stored["content"])
		if e != nil {
			return nil, e
		}
		if stored["state"] != r["state"] || after != before {
			changed++
		}
	}
	var next any
	if len(records) > limit {
		next = records[limit-1]["version_id"]
	}
	return Object{"checked": min(len(records), limit), "changed": changed, "nextAfter": next}, nil
}
