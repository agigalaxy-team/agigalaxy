package information

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math"
)

func fmtBatch(revision, due int64) string { return fmt.Sprintf("daily:%d:%d", revision, due) }
func mergeRefs(before, added []any) []any {
	out := append([]any{}, before...)
	indices := map[string]int{}
	for i, v := range out {
		indices[text(obj(v), "id")] = i
	}
	for _, v := range added {
		id := text(obj(v), "id")
		if index, found := indices[id]; found {
			out[index] = v
		} else {
			indices[id] = len(out)
			out = append(out, v)
		}
	}
	return out
}

type scanResult struct {
	state    string
	after    any
	refs     []any
	complete bool
	baseline any
	changes  []any
}

func (s *Watches) scanSource(ctx context.Context, a *deviceauth.Actor, selection, previous Object, baseline any) (scanResult, error) {
	after := previous["after"]
	refs := []any{}
	if text(previous, "after") != "" {
		refs = append(refs, list(previous["refs"])...)
	}
	seen := map[string]bool{}
	var last Object
	for page := 0; page < 5; page++ {
		if e := ctx.Err(); e != nil {
			return scanResult{}, e
		}
		var e error
		last, e = s.Information.Source(ctx, a, Object{"key": selection["key"], "source": WithCursor(obj(selection["source"]), after)})
		if e != nil {
			return scanResult{}, e
		}
		if last["complete"] != true && last["nextCursor"] == nil {
			changes := []any{}
			if baseline != nil && previous["state"] != last["state"] {
				changes = append(changes, Object{"key": selection["key"], "kind": "availability-changed", "state": last["state"]})
			}
			return scanResult{text(last, "state"), nil, []any{}, false, baseline, changes}, nil
		}
		refs = mergeRefs(refs, list(last["sourceVersions"]))
		after = last["nextCursor"]
		if after == nil || after == "" {
			break
		}
		cursor, _ := after.(string)
		if seen[cursor] {
			return scanResult{}, fault.New("information_source_cursor_loop", 503)
		}
		seen[cursor] = true
	}
	if after != nil && after != "" {
		return scanResult{text(last, "state"), after, refs, false, baseline, []any{}}, nil
	}
	changes := []any{}
	if baseline != nil && previous["complete"] == false && text(previous, "after") == "" && text(previous, "state") != "" && previous["state"] != last["state"] {
		changes = append(changes, Object{"key": selection["key"], "kind": "availability-changed", "state": last["state"]})
	}
	if baseline != nil {
		old, current := map[string]any{}, map[string]bool{}
		for _, r := range list(baseline) {
			o := obj(r)
			old[text(o, "id")] = o["version"]
		}
		for _, r := range refs {
			o := obj(r)
			id := text(o, "id")
			current[id] = true
			if prior, found := old[id]; !found || prior != o["version"] {
				kind := "new-visible-source"
				if found {
					kind = "source-changed"
				}
				changes = append(changes, Object{"key": selection["key"], "id": id, "kind": kind, "version": o["version"]})
			}
		}
		for _, r := range list(baseline) {
			o := obj(r)
			if !current[text(o, "id")] {
				changes = append(changes, Object{"key": selection["key"], "id": o["id"], "kind": "no-longer-in-current-scope"})
			}
		}
	}
	return scanResult{text(last, "state"), nil, []any{}, true, refs, changes}, nil
}
func (s *Watches) Check(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	x, e := parseWatch(raw, "check")
	if e != nil {
		return nil, e
	}
	if s.CanProcessEvidence != nil && !s.CanProcessEvidence() {
		return nil, fault.New("service_writes_stopped", 410)
	}
	if s.Information == nil {
		return nil, fault.New("information_source_unavailable", 503)
	}
	capture, e := s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		r, e := s.rowWithin(ctx, tx, a, text(x, "watchId"), false)
		if e != nil {
			return nil, e
		}
		if number(r, "revision") != number(x, "expectedRevision") {
			return nil, fault.New("information_watch_revision_conflict", 409)
		}
		return r, nil
	})
	if e != nil {
		return nil, e
	}
	if capture["state"] != "active" || seconds(capture["expires_at"]) <= s.now() {
		return merge(Object{"state": s.view(capture)["state"], "changed": false}, s.runtime(capture)), nil
	}
	if capture["next_check_at"] != nil && seconds(capture["next_check_at"]) > s.now() {
		return merge(Object{"state": "not-due", "nextCheckAt": seconds(capture["next_check_at"])}, s.runtime(capture)), nil
	}
	scan := build()
	baseline := copyObject(obj(capture["baseline"]))
	changes := []any{}
	for _, selected := range list(obj(capture["plan"])["sources"]) {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		selection := obj(selected)
		key := text(selection, "key")
		result, e := s.scanSource(ctx, &a, selection, obj(obj(capture["scan"])[key]), baseline[key])
		if e != nil {
			return nil, e
		}
		scan.Set(key, Object{"state": result.state, "after": result.after, "refs": result.refs, "complete": result.complete})
		if result.complete {
			baseline[key] = result.baseline
		}
		changes = append(changes, result.changes...)
	}
	return s.run(ctx, a, true, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		if e := ctx.Err(); e != nil {
			return nil, e
		}
		r, e := s.rowWithin(ctx, tx, a, text(x, "watchId"), true)
		if e != nil {
			return nil, e
		}
		if r["state"] != "active" || number(r, "revision") != number(capture, "revision") || number(r, "check_revision") != number(capture, "check_revision") || seconds(r["expires_at"]) <= s.now() {
			return merge(Object{"state": "superseded-during-check", "changed": false}, s.runtime(r)), nil
		}
		failed, partial := false, false
		for _, key := range scan.Keys() {
			v := obj(scan.Values()[key])
			failed = failed || v["state"] == "temporarily-unavailable"
			partial = partial || text(v, "after") != ""
		}
		failures := int64(0)
		delay := int64(900)
		if failed {
			failures = number(r, "failures") + 1
			delay = int64(math.Min(1800, 60*math.Pow(2, float64(min(failures-1, 5)))))
		} else if partial {
			delay = 0
		}
		next := s.now() + delay
		if _, e = tx.Exec(ctx, `UPDATE information_watches_v2 SET baseline=$3::jsonb,scan=$4::jsonb,check_revision=check_revision+1,last_checked_at=$5,next_check_at=$6,failures=$7,background_state='scheduled',background_error=NULL WHERE id=$1 AND subject_id=$2`, r["id"], a.SubjectID, string(encode(baseline)), string(encode(scan)), s.at(s.now()), s.at(next), failures); e != nil {
			return nil, e
		}
		var eventID any
		if len(changes) > 0 {
			due, batch := s.now(), uuid.NewString()
			if report := obj(obj(r["plan"])["report"]); report["mode"] == "daily" {
				due = s.now()/86400*86400 + number(report, "utcMinute")*60
				if due <= s.now() {
					due += 86400
				}
				batch = fmtBatch(number(r, "revision"), due)
			}
			prior, e := query(ctx, tx, `SELECT id::text,changes FROM information_watch_changes_v2 WHERE watch_id=$1 AND batch_key=$2 FOR UPDATE`, r["id"], batch)
			if e != nil {
				return nil, e
			}
			merged := []any{}
			if len(prior) > 0 {
				eventID = prior[0]["id"]
				merged = append(merged, list(prior[0]["changes"])...)
			} else {
				eventID = uuid.NewString()
			}
			merged = append(merged, changes...)
			unique := []any{}
			indices := map[string]int{}
			for _, v := range merged {
				c := obj(v)
				id := text(c, "id")
				if id == "" {
					id = "availability"
				}
				key := text(c, "key") + ":" + id
				if index, present := indices[key]; present {
					unique[index] = v
				} else {
					indices[key] = len(unique)
					unique = append(unique, v)
				}
			}
			expires := min(due+90*86400, seconds(r["expires_at"])+90*86400)
			if _, e = tx.Exec(ctx, `INSERT INTO information_watch_changes_v2(id,subject_id,watch_id,batch_key,changes,created_at,available_at,expires_at,watch_revision) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9) ON CONFLICT(watch_id,batch_key) DO UPDATE SET changes=EXCLUDED.changes`, eventID, a.SubjectID, r["id"], batch, string(encode(unique)), s.at(s.now()), s.at(due), s.at(expires), number(r, "revision")); e != nil {
				return nil, e
			}
		}
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		nextRow := copyObject(r)
		nextRow["check_revision"] = number(r, "check_revision") + 1
		nextRow["next_check_at"] = s.at(next)
		if e = s.queueWithin(ctx, tx, nextRow); e != nil {
			return nil, e
		}
		state := "unchanged"
		switch {
		case partial:
			state = "coverage-in-progress"
		case failed:
			state = "partial-source-failure"
		case len(changes) > 0:
			state = "changed"
		}
		coverage := []any{}
		for _, key := range scan.Keys() {
			v := obj(scan.Values()[key])
			coverage = append(coverage, Object{"key": key, "complete": v["complete"], "sourceState": v["state"]})
		}
		return merge(Object{"state": state, "watchId": r["id"], "eventId": eventID, "changed": len(changes) > 0, "nextCheckAt": next, "coverage": coverage}, s.runtime(r)), nil
	})
}
