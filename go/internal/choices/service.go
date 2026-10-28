// Package choices retains the owner's explicit Choice synchronization and
// accepted-operation receipts. A selected reference does not apply its source.
package choices

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type SourceReader interface {
	WitnessWithin(context.Context, pgx.Tx, deviceauth.Actor, Object) (Object, error)
	StatusWithin(context.Context, pgx.Tx, deviceauth.Actor, Object) (Object, error)
	ResultWithin(context.Context, pgx.Tx, deviceauth.Actor, Object) (Object, error)
}
type Service struct {
	Pool      *pgxpool.Pool
	Endpoint  string
	Devices   *deviceauth.Service
	Resources *resourcebudget.Service
	Sources   SourceReader
	// ErasureViewWithin is an internal, erasure-only current-source observer.
	// It must represent the retained replica owner without fabricating a device
	// credential. Absent authority leaves this maintenance pass unavailable.
	ErasureViewWithin func(context.Context, pgx.Tx, string, Object) (Object, error)
	Now               func() time.Time
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func stamp(n int64) string { return time.Unix(n, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
func timestamp(v any) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, str(Object{"v": v}, "v"))
}
func iso(v any) string {
	t, e := timestamp(v)
	if e != nil {
		return ""
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var v Object
	e := tx.QueryRow(ctx, sql, args...).Scan(&v)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	return v, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		var v Object
		if e = r.Scan(&v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, r.Err()
}
func (s *Service) run(ctx context.Context, a deviceauth.Actor, write bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	if write {
		if e := deviceauth.CheckInformationWatchWrite(a, "binding"); e != nil {
			return nil, e
		}
	}
	if s == nil || s.Pool == nil || s.Devices == nil || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("choice_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		authorize := func(ctx context.Context, tx pgx.Tx) error { return s.Devices.AuthorizeWithin(ctx, tx, a, "binding") }
		if write {
			budget := s.Resources
			if budget == nil {
				budget, _ = resourcebudget.New(nil, s.Now)
			}
			out, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.SubjectID}, authorize, func(context.Context, pgx.Tx) (any, error) { return fn(tx) }, resourcebudget.Options{})
			if e != nil {
				return nil, e
			}
			return object(out), nil
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		return fn(tx)
	})
}
func absent(e error) bool {
	var f *fault.Error
	return errors.As(e, &f) && (f.Status == 403 || f.Status == 404 || f.Status == 409 || f.Status == 422)
}
func (s *Service) preferenceWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor) (Object, error) {
	p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM choice_snapshot_preferences p WHERE subject_id=$1", a.SubjectID)
	if e != nil {
		return nil, e
	}
	revision := any(0)
	enabled := any(false)
	ids := any([]any{})
	if p != nil {
		revision, enabled, ids = p["revision"], p["enabled"], p["snapshot_ids"]
	}
	return Object{"category": "choice-snapshot", "revision": revision, "endpoint": s.Endpoint, "enabled": enabled, "snapshotIds": ids, "audience": "owner-only", "contentInactiveDays": 30, "personalSummaryPreferenceApplied": false}, nil
}
func (s *Service) Preferences(ctx context.Context, a deviceauth.Actor) (Object, error) {
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) { return s.preferenceWithin(ctx, tx, a) })
}
func (s *Service) SavePreference(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("preferences/save", input)
	if e != nil {
		return nil, e
	}
	if x["endpoint"] != s.Endpoint {
		return nil, fail("choice_endpoint_mismatch", 400)
	}
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, "INSERT INTO choice_snapshot_preferences(subject_id,endpoint,updated_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", a.SubjectID, s.Endpoint, stamp(s.now())); e != nil {
			return nil, e
		}
		p, e := row(ctx, tx, "SELECT to_jsonb(p) FROM choice_snapshot_preferences p WHERE subject_id=$1 FOR UPDATE", a.SubjectID)
		if e != nil {
			return nil, e
		}
		if number(p["revision"]) != number(x["expectedRevision"]) {
			return nil, fail("choice_preference_conflict")
		}
		if _, e = tx.Exec(ctx, "UPDATE choice_snapshot_preferences SET enabled=$2,snapshot_ids=$3,revision=revision+1,updated_at=$4 WHERE subject_id=$1", a.SubjectID, x["enabled"], x["snapshotIds"], stamp(s.now())); e != nil {
			return nil, e
		}
		return s.preferenceWithin(ctx, tx, a)
	})
}
func (s *Service) viewWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, r Object) (Object, error) {
	if r == nil {
		return nil, nil
	}
	state := str(r, "state")
	content := object(r["content"])
	statuses := []any{}
	expires, e := timestamp(r["expires_at"])
	if e != nil {
		return nil, e
	}
	if (state == "current" || state == "conflict" || state == "invalidated") && !expires.After(time.Unix(s.now(), 0)) {
		state = "expired"
		content = Object{}
		if _, e = tx.Exec(ctx, "UPDATE choice_snapshot_versions SET state='expired',content='{}',dependencies='[]' WHERE subject_id=$1 AND version_id=$2", a.SubjectID, r["version_id"]); e != nil {
			return nil, e
		}
	}
	current := true
	if state == "current" || state == "conflict" {
		if s.Sources == nil {
			return nil, fail("choice_source_reader_unavailable", 503)
		}
		for _, v := range array(r["dependencies"]) {
			status, e := s.Sources.StatusWithin(ctx, tx, a, object(v))
			if e != nil {
				return nil, e
			}
			statuses = append(statuses, status)
			if status["state"] != "current" {
				current = false
			}
		}
		for _, v := range array(content["resultRefs"]) {
			status := "current"
			if _, e = s.Sources.ResultWithin(ctx, tx, a, object(v)); e != nil {
				if !absent(e) {
					return nil, e
				}
				status = "unavailable"
				current = false
			}
			statuses = append(statuses, Object{"resultRef": v, "state": status})
		}
		if !current {
			c := Object{}
			for k, v := range content {
				c[k] = v
			}
			c["visibleRationale"], c["rationaleUnavailable"] = nil, true
			content = c
		}
	}
	return Object{"snapshotId": r["snapshot_id"], "versionId": r["version_id"], "revision": r["revision"], "baseRevision": r["base_revision"], "state": state, "content": content, "sourceStatus": statuses, "priorRationaleCurrent": content["rationaleUnavailable"] != true && len(statuses) > 0 && current, "queryContextReevaluated": false, "createdAt": iso(r["created_at"]), "expiresAt": iso(r["expires_at"]), "selectionIsApplication": false}, nil
}
func (s *Service) getWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
	h, e := row(ctx, tx, "SELECT to_jsonb(h) FROM choice_snapshot_heads h WHERE subject_id=$1 AND snapshot_id=$2 FOR UPDATE", a.SubjectID, id)
	if e != nil {
		return nil, e
	}
	if h == nil {
		return Object{"snapshotId": id, "revision": 0, "current": nil, "conflicts": []any{}, "audience": "owner-only"}, nil
	}
	records, e := rows(ctx, tx, "SELECT to_jsonb(v) FROM choice_snapshot_versions v WHERE subject_id=$1 AND snapshot_id=$2 AND (version_id=$3 OR state='conflict') ORDER BY created_at,version_id", a.SubjectID, id, h["current_version_id"])
	if e != nil {
		return nil, e
	}
	var current any
	conflicts := []any{}
	for _, r := range records {
		v, e := s.viewWithin(ctx, tx, a, r)
		if e != nil {
			return nil, e
		}
		if r["version_id"] == h["current_version_id"] {
			current = v
		} else if v["state"] == "conflict" {
			conflicts = append(conflicts, v)
		}
	}
	return Object{"snapshotId": id, "revision": h["revision"], "current": current, "conflicts": conflicts, "audience": "owner-only", "shared": false, "deleted": h["deleted_at"] != nil}, nil
}
func (s *Service) Get(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("get", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) { return s.getWithin(ctx, tx, a, str(x, "snapshotId")) })
}
func (s *Service) ReceiptWithin(ctx context.Context, tx pgx.Tx, subject string, input Object) (Object, error) {
	x, e := Parse("receipt", input)
	if e != nil {
		return nil, e
	}
	r, e := row(ctx, tx, "SELECT jsonb_build_object('snapshot_id',snapshot_id,'version_id',version_id,'request_hash',request_hash,'base_revision',base_revision,'revision',revision,'state',state,'created_at',created_at,'expires_at',expires_at) FROM choice_snapshot_versions WHERE subject_id=$1 AND version_id=$2", subject, x["versionId"])
	if e != nil {
		return nil, e
	}
	out := Object{"snapshotId": x["snapshotId"], "versionId": x["versionId"], "requestHash": x["requestHash"], "authority": "accepted-operation-only", "audience": "owner-only", "currentAccessGranted": false, "contentReturned": false, "sourceAccessChecked": false}
	if r == nil {
		out["state"], out["absenceMeaning"] = "absent", "no-retained-owner-operation"
	} else if r["snapshot_id"] != x["snapshotId"] || r["request_hash"] != x["requestHash"] {
		out["state"], out["reason"] = "conflict", "original-operation-mismatch"
	} else {
		expires, e := timestamp(r["expires_at"])
		if e != nil {
			return nil, e
		}
		out["state"] = "acknowledged"
		out["receipt"] = Object{"snapshotId": r["snapshot_id"], "versionId": r["version_id"], "requestHash": r["request_hash"], "baseRevision": r["base_revision"], "revision": r["revision"], "storedState": r["state"], "acceptedAt": iso(r["created_at"]), "contentExpiresAt": iso(r["expires_at"]), "contentRetentionDue": !expires.After(time.Unix(s.now(), 0))}
	}
	return out, nil
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) { return s.ReceiptWithin(ctx, tx, a.SubjectID, input) })
}
func (s *Service) List(ctx context.Context, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("list", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx) (Object, error) { return s.ExportOwnedWithin(ctx, tx, a, x) })
}
func (s *Service) ExportOwnedWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, input Object) (Object, error) {
	x, e := Parse("list", input)
	if e != nil {
		return nil, e
	}
	limit := int(number(x["limit"]))
	rs, e := rows(ctx, tx, "SELECT jsonb_build_object('snapshot_id',snapshot_id) FROM choice_snapshot_heads WHERE subject_id=$1 AND deleted_at IS NULL AND ($2::uuid IS NULL OR snapshot_id>$2) ORDER BY snapshot_id LIMIT $3", a.SubjectID, x["after"], limit+1)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, r := range rs[:min(len(rs), limit)] {
		v, e := s.getWithin(ctx, tx, a, str(r, "snapshot_id"))
		if e != nil {
			return nil, e
		}
		items = append(items, v)
	}
	var next any
	if len(rs) > limit {
		next = rs[limit-1]["snapshot_id"]
	}
	return Object{"items": items, "nextAfter": next, "audience": "owner-only"}, nil
}
