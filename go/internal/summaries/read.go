package summaries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func (s *Service) getWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	h, e := row(ctx, tx, "SELECT to_jsonb(h) FROM personal_summary_heads h WHERE subject_id=$1 AND summary_id=$2 FOR UPDATE", a.SubjectID, id)
	if e != nil {
		return nil, e
	}
	if h == nil {
		return Object{"summaryId": id, "revision": 0, "current": nil, "conflicts": []any{}, "audience": "owner-only", "sharedToRoom": false}, nil
	}
	records, e := rows(ctx, tx, "SELECT to_jsonb(v) FROM personal_summary_versions v WHERE subject_id=$1 AND summary_id=$2 AND (version_id=$3 OR state='conflict') ORDER BY created_at,version_id", a.SubjectID, id, h["current_version_id"])
	if e != nil {
		return nil, e
	}
	var current any
	conflicts := []any{}
	for _, r := range records {
		v, e := s.viewWithin(ctx, tx, a, r, str(h, "room_id"))
		if e != nil {
			return nil, e
		}
		if r["version_id"] == h["current_version_id"] {
			current = v
		} else if v["state"] == "conflict" {
			conflicts = append(conflicts, v)
		}
	}
	return Object{"summaryId": id, "roomId": h["room_id"], "revision": h["revision"], "current": current, "conflicts": conflicts, "audience": "owner-only", "sharedToRoom": false}, nil
}
func (s *Service) Get(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("get", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) { return s.getWithin(ctx, tx, a, str(x, "summaryId")) })
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("receipt", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		r, e := row(ctx, tx, "SELECT jsonb_build_object('version_id',version_id,'summary_id',summary_id,'revision',revision,'base_revision',base_revision,'state',state) FROM personal_summary_versions WHERE subject_id=$1 AND version_id=$2", a.SubjectID, x["versionId"])
		if e != nil {
			return nil, e
		}
		if r == nil {
			return Object{"state": "absent", "operationVersionId": x["versionId"], "summaryId": x["summaryId"], "readOnly": true}, nil
		}
		if r["summary_id"] != x["summaryId"] {
			return nil, fail("summary_operation_conflict")
		}
		summary, e := s.getWithin(ctx, tx, a, str(x, "summaryId"))
		if e != nil {
			return nil, e
		}
		return Object{"state": "committed", "operationVersionId": x["versionId"], "operation": Object{"versionId": r["version_id"], "summaryId": r["summary_id"], "revision": r["revision"], "baseRevision": r["base_revision"], "state": r["state"]}, "summary": summary, "readOnly": true}, nil
	})
}
func (s *Service) ExportOwnedWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("list", input)
	if e != nil {
		return nil, e
	}
	limit := int(number(x["limit"]))
	records, e := rows(ctx, tx, "SELECT jsonb_build_object('summary_id',summary_id) FROM personal_summary_heads WHERE subject_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR summary_id>$2) ORDER BY summary_id LIMIT $3", a.SubjectID, x["after"], limit+1)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, r := range records[:min(len(records), limit)] {
		v, e := s.getWithin(ctx, tx, a, str(r, "summary_id"))
		if e != nil {
			return nil, e
		}
		items = append(items, v)
	}
	var next any
	if len(records) > limit {
		next = records[limit-1]["summary_id"]
	}
	return Object{"items": items, "nextAfter": next, "audience": "owner-only"}, nil
}
func (s *Service) List(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) { return s.ExportOwnedWithin(ctx, tx, a, input) })
}
func (s *Service) Sources(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("sources", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		if s.Source == nil {
			return nil, fail("summary_source_adapter_unavailable", 503)
		}
		items := []any{}
		for _, ref := range array(x["refs"]) {
			r := object(ref)
			q := Object{"roomId": x["roomId"], "messageId": r["messageId"], "revision": r["revision"]}
			status, e := s.Source(ctx, tx, a, q)
			if e != nil {
				return nil, e
			}
			item := Object{"messageId": r["messageId"], "revision": r["revision"]}
			for k, v := range status {
				item[k] = v
			}
			items = append(items, item)
		}
		return Object{"items": items, "checkedAt": stamp(s.now())}, nil
	})
}
