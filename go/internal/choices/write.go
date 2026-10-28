package choices

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func contentDigest(content Object) (string, error) {
	effective := Object{}
	for k, v := range content {
		if k != "localVersion" {
			effective[k] = v
		}
	}
	return digestIntent(effective)
}
func PutIntent(parsed Object) Object {
	out := Object{}
	for k, v := range parsed {
		if k != "preferenceRevision" && k != "witnesses" {
			out[k] = v
		}
	}
	return out
}
func (s *Service) Put(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("put", input)
	if e != nil {
		return nil, e
	}
	hash, e := digestIntent(PutIntent(x))
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM choice_snapshot_preferences p WHERE subject_id=$1 FOR SHARE", a.SubjectID)
		if e != nil {
			return nil, e
		}
		selected := false
		for _, v := range array(p["snapshot_ids"]) {
			if v == x["snapshotId"] {
				selected = true
			}
		}
		if p == nil || p["enabled"] != true || p["endpoint"] != s.Endpoint || number(p["revision"]) != number(x["preferenceRevision"]) || !selected {
			return nil, fail("choice_sync_not_authorized", 403)
		}
		if _, e = tx.Exec(ctx, "INSERT INTO choice_snapshot_heads(subject_id,snapshot_id,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT DO NOTHING", a.SubjectID, x["snapshotId"], stamp(s.now())); e != nil {
			return nil, e
		}
		h, e := row(ctx, tx, "SELECT to_jsonb(h) FROM choice_snapshot_heads h WHERE subject_id=$1 AND snapshot_id=$2 FOR UPDATE", a.SubjectID, x["snapshotId"])
		if e != nil {
			return nil, e
		}
		replay, e := row(ctx, tx, "SELECT to_jsonb(v) FROM choice_snapshot_versions v WHERE subject_id=$1 AND version_id=$2", a.SubjectID, x["versionId"])
		if e != nil {
			return nil, e
		}
		if replay != nil {
			if replay["snapshot_id"] != x["snapshotId"] || replay["request_hash"] != hash {
				return nil, fail("choice_operation_conflict")
			}
			v, e := s.getWithin(ctx, tx, a, str(x, "snapshotId"))
			if e != nil {
				return nil, e
			}
			v["operationVersionId"], v["replayed"] = x["versionId"], true
			return v, nil
		}
		byRef := map[string]Object{}
		for _, value := range array(x["witnesses"]) {
			w := object(value)
			r := object(w["ref"])
			ref := Object{"type": object(w["search"])["type"], "id": r["id"], "version": r["version"]}
			byRef[key(ref)] = w
		}
		content := object(x["content"])
		if len(byRef) != len(array(content["candidateRefs"])) {
			return nil, fail("choice_witness_mismatch", 400)
		}
		for _, ref := range array(content["candidateRefs"]) {
			if byRef[key(object(ref))] == nil {
				return nil, fail("choice_witness_mismatch", 400)
			}
		}
		if s.Sources == nil {
			return nil, fail("choice_source_reader_unavailable", 503)
		}
		dependencies := []any{}
		for _, ref := range array(content["candidateRefs"]) {
			dep, e := s.Sources.WitnessWithin(ctx, tx, a, byRef[key(object(ref))])
			if e != nil {
				return nil, e
			}
			dependencies = append(dependencies, dep)
		}
		for _, ref := range array(content["resultRefs"]) {
			if _, e = s.Sources.ResultWithin(ctx, tx, a, object(ref)); e != nil {
				return nil, e
			}
		}
		conflict := number(x["baseRevision"]) != number(h["revision"])
		revision := number(h["revision"])
		if !conflict {
			revision++
		}
		var previous Object
		if h["current_version_id"] != nil {
			previous, e = row(ctx, tx, "SELECT jsonb_build_object('content',content,'expires_at',expires_at) FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2", a.SubjectID, h["current_version_id"])
			if e != nil {
				return nil, e
			}
		}
		expires := stamp(s.now() + 30*86400)
		unchanged := false
		if object(previous["content"])["candidateRefs"] != nil {
			before, e := contentDigest(object(previous["content"]))
			if e != nil {
				return nil, e
			}
			after, e := contentDigest(content)
			if e != nil {
				return nil, e
			}
			unchanged = before == after
		}
		if unchanged {
			expires = iso(previous["expires_at"])
			t, e := timestamp(expires)
			if e != nil {
				return nil, e
			}
			if t.Unix() <= s.now() {
				return nil, fail("choice_expired_content_requires_new_choice")
			}
		}
		resolve := array(x["resolveVersionIds"])
		if conflict && len(resolve) > 0 {
			return nil, fail("choice_resolution_conflict")
		}
		if !conflict {
			for _, id := range resolve {
				old, e := row(ctx, tx, "SELECT jsonb_build_object('state',state) FROM choice_snapshot_versions WHERE subject_id=$1 AND snapshot_id=$2 AND version_id=$3", a.SubjectID, x["snapshotId"], id)
				if e != nil {
					return nil, e
				}
				if old["state"] != "conflict" {
					return nil, fail("choice_resolution_conflict")
				}
			}
			ids := []string{}
			for _, v := range resolve {
				id, _ := v.(string)
				ids = append(ids, id)
			}
			if _, e = tx.Exec(ctx, "UPDATE choice_snapshot_versions SET state='superseded',content='{}',dependencies='[]' WHERE subject_id=$1 AND snapshot_id=$2 AND (state='current' OR version_id=ANY($3::uuid[]))", a.SubjectID, x["snapshotId"], ids); e != nil {
				return nil, e
			}
		}
		state := "current"
		syncState := "synced"
		if conflict {
			state = "conflict"
			syncState = "conflict"
		}
		if _, e = tx.Exec(ctx, "INSERT INTO choice_snapshot_versions(subject_id,snapshot_id,version_id,base_revision,revision,request_hash,state,content,dependencies,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", a.SubjectID, x["snapshotId"], x["versionId"], x["baseRevision"], revision, hash, state, content, dependencies, stamp(s.now()), expires); e != nil {
			return nil, e
		}
		if !conflict {
			if _, e = tx.Exec(ctx, "UPDATE choice_snapshot_heads SET revision=$3,current_version_id=$4,deleted_at=NULL,updated_at=$5 WHERE subject_id=$1 AND snapshot_id=$2", a.SubjectID, x["snapshotId"], revision, x["versionId"], stamp(s.now())); e != nil {
				return nil, e
			}
		}
		v, e := s.getWithin(ctx, tx, a, str(x, "snapshotId"))
		if e != nil {
			return nil, e
		}
		v["operationVersionId"], v["syncState"] = x["versionId"], syncState
		return v, nil
	})
}
func (s *Service) Delete(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("delete", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) {
		h, e := row(ctx, tx, "SELECT to_jsonb(h) FROM choice_snapshot_heads h WHERE subject_id=$1 AND snapshot_id=$2 FOR UPDATE", a.SubjectID, x["snapshotId"])
		if e != nil {
			return nil, e
		}
		out := Object{"snapshotId": x["snapshotId"], "deleted": true, "localDeleted": false}
		if h == nil {
			return out, nil
		}
		if h["deleted_at"] == nil && number(h["revision"]) != number(x["expectedRevision"]) {
			return nil, fail("choice_revision_conflict")
		}
		if _, e = tx.Exec(ctx, "UPDATE choice_snapshot_versions SET state='deleted',content='{}',dependencies='[]' WHERE subject_id=$1 AND snapshot_id=$2", a.SubjectID, x["snapshotId"]); e != nil {
			return nil, e
		}
		if h["deleted_at"] == nil {
			if _, e = tx.Exec(ctx, "UPDATE choice_snapshot_heads SET deleted_at=$3,revision=revision+1,updated_at=$3 WHERE subject_id=$1 AND snapshot_id=$2", a.SubjectID, x["snapshotId"], stamp(s.now())); e != nil {
				return nil, e
			}
		}
		return out, nil
	})
}
func (s *Service) PurgeExpiredWithin(ctx context.Context, tx pgx.Tx) (Object, error) {
	r, e := tx.Exec(ctx, "UPDATE choice_snapshot_versions SET state='expired',content='{}',dependencies='[]' WHERE (subject_id,version_id) IN (SELECT subject_id,version_id FROM choice_snapshot_versions WHERE state IN ('current','conflict','invalidated') AND expires_at<=$1 ORDER BY expires_at,version_id LIMIT 100)", stamp(s.now()))
	if e != nil {
		return nil, e
	}
	return Object{"expiredChoiceVersions": r.RowsAffected()}, nil
}
