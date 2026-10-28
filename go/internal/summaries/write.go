package summaries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Put(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("put", input)
	if e != nil {
		return nil, e
	}
	intent := Object{}
	for k, v := range x {
		if k != "preferenceRevision" {
			intent[k] = v
		}
	}
	hash, e := digestIntent(intent)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM personal_summary_preferences p WHERE subject_id=$1 FOR SHARE", a.SubjectID)
		if e != nil {
			return nil, e
		}
		roomAllowed := true
		if p["room_ids"] != nil {
			roomAllowed = false
			for _, v := range array(p["room_ids"]) {
				if v == x["roomId"] {
					roomAllowed = true
				}
			}
		}
		if p == nil || p["enabled"] != true || p["endpoint"] != s.Endpoint || number(p["revision"]) != number(x["preferenceRevision"]) || !roomAllowed {
			return nil, fail("summary_sync_not_authorized", 403)
		}
		if s.Source == nil {
			return nil, fail("summary_room_unavailable", 403)
		}
		room, e := s.Source(ctx, tx, a, Object{"roomId": x["roomId"]})
		if e != nil {
			return nil, e
		}
		if room["available"] != true {
			return nil, fail("summary_room_unavailable", 403)
		}
		if _, e = tx.Exec(ctx, "INSERT INTO personal_summary_heads(subject_id,summary_id,room_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT DO NOTHING", a.SubjectID, x["summaryId"], x["roomId"], stamp(s.now())); e != nil {
			return nil, e
		}
		h, e := row(ctx, tx, "SELECT to_jsonb(h) FROM personal_summary_heads h WHERE subject_id=$1 AND summary_id=$2 FOR UPDATE", a.SubjectID, x["summaryId"])
		if e != nil {
			return nil, e
		}
		if h["room_id"] != x["roomId"] {
			return nil, fail("summary_room_conflict")
		}
		replay, e := row(ctx, tx, "SELECT to_jsonb(v) FROM personal_summary_versions v WHERE subject_id=$1 AND version_id=$2", a.SubjectID, x["versionId"])
		if e != nil {
			return nil, e
		}
		if replay != nil {
			if replay["request_hash"] != hash || replay["summary_id"] != x["summaryId"] {
				return nil, fail("summary_operation_conflict")
			}
			v, e := s.getWithin(ctx, tx, a, str(x, "summaryId"))
			if e != nil {
				return nil, e
			}
			v["operationVersionId"], v["replayed"] = x["versionId"], true
			return v, nil
		}
		filtered, e := s.filterWithin(ctx, tx, a, str(x, "roomId"), object(x["content"]))
		if e != nil {
			return nil, e
		}
		if filtered.Invalidated {
			return nil, fail("summary_sources_changed")
		}
		conflict := number(x["baseRevision"]) != number(h["revision"])
		revision := number(h["revision"])
		if !conflict {
			revision++
			ids := []string{}
			for _, v := range array(x["resolveVersionIds"]) {
				id, _ := v.(string)
				r, e := row(ctx, tx, "SELECT jsonb_build_object('state',state) FROM personal_summary_versions WHERE subject_id=$1 AND summary_id=$2 AND version_id=$3", a.SubjectID, x["summaryId"], id)
				if e != nil {
					return nil, e
				}
				if r == nil || r["state"] != "conflict" {
					return nil, fail("summary_resolution_conflict")
				}
				ids = append(ids, id)
			}
			if _, e = tx.Exec(ctx, "UPDATE personal_summary_versions SET state='superseded',content='{}'::jsonb WHERE subject_id=$1 AND summary_id=$2 AND (state='current' OR version_id=ANY($3::uuid[]))", a.SubjectID, x["summaryId"], ids); e != nil {
				return nil, e
			}
		}
		state, sync := "current", "synced"
		if conflict {
			state, sync = "conflict", "conflict"
		}
		if _, e = tx.Exec(ctx, "INSERT INTO personal_summary_versions(subject_id,summary_id,version_id,base_revision,revision,request_hash,state,content,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", a.SubjectID, x["summaryId"], x["versionId"], x["baseRevision"], revision, hash, state, x["content"], stamp(s.now()), stamp(s.now()+30*86400)); e != nil {
			return nil, e
		}
		if !conflict {
			if _, e = tx.Exec(ctx, "UPDATE personal_summary_heads SET revision=$3,current_version_id=$4,deleted_at=NULL,updated_at=$5 WHERE subject_id=$1 AND summary_id=$2", a.SubjectID, x["summaryId"], revision, x["versionId"], stamp(s.now())); e != nil {
				return nil, e
			}
		}
		v, e := s.getWithin(ctx, tx, a, str(x, "summaryId"))
		if e != nil {
			return nil, e
		}
		v["operationVersionId"], v["syncState"] = x["versionId"], sync
		return v, nil
	})
}
func (s *Service) Delete(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("delete", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		h, e := row(ctx, tx, "SELECT to_jsonb(h) FROM personal_summary_heads h WHERE subject_id=$1 AND summary_id=$2 FOR UPDATE", a.SubjectID, x["summaryId"])
		if e != nil {
			return nil, e
		}
		out := Object{"summaryId": x["summaryId"], "deleted": true, "localDeleted": false}
		if h == nil {
			return out, nil
		}
		if h["deleted_at"] == nil && number(h["revision"]) != number(x["expectedRevision"]) {
			return nil, fail("summary_version_conflict")
		}
		if _, e = tx.Exec(ctx, "UPDATE personal_summary_versions SET state='deleted',content='{}'::jsonb WHERE subject_id=$1 AND summary_id=$2", a.SubjectID, x["summaryId"]); e != nil {
			return nil, e
		}
		if h["deleted_at"] == nil {
			if _, e = tx.Exec(ctx, "UPDATE personal_summary_heads SET deleted_at=$3,revision=revision+1,updated_at=$3 WHERE subject_id=$1 AND summary_id=$2", a.SubjectID, x["summaryId"], stamp(s.now())); e != nil {
				return nil, e
			}
		}
		return out, nil
	})
}
