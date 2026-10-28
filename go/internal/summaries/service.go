// Package summaries stores only explicitly selected owner-derived fragments.
// It does not read whole conversations or run a model.
package summaries

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	whatwg "github.com/nlnwa/whatwg-url/url"
	"time"
)

type SourceReader func(context.Context, pgx.Tx, deviceauth.Actor, Object) (Object, error)
type Service struct {
	Pool          *pgxpool.Pool
	Endpoint      string
	Devices       *deviceauth.Service
	Resources     *resourcebudget.Service
	Source        SourceReader
	Now           func() time.Time
	ErasureSource func(context.Context, pgx.Tx, string, Object) (Object, error)
}

func New(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, now func() time.Time) (*Service, error) {
	u, e := whatwg.Parse(endpoint)
	if e != nil || u.Scheme() != "https" || u.Host() == "" || "https://"+u.Host() != endpoint {
		return nil, errors.New("invalid summary service origin")
	}
	return &Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now}, nil
}

func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func stamp(n int64) string                { return time.Unix(n, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
func parsedTime(v any) (time.Time, error) { s, _ := v.(string); return time.Parse(time.RFC3339Nano, s) }
func iso(v any) string {
	t, e := parsedTime(v)
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
func clone(v Object) (Object, error) {
	raw, e := jstext.EncodeJSON(v)
	if e != nil {
		return nil, e
	}
	value, e := jstext.DecodeJSON(raw)
	return object(value), e
}
func (s *Service) run(ctx context.Context, a deviceauth.Actor, write bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	if write {
		if e := deviceauth.CheckInformationWatchWrite(a, "binding"); e != nil {
			return nil, e
		}
	}
	if s == nil || s.Pool == nil || s.Devices == nil || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("summary_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		authorize := func(ctx context.Context, tx pgx.Tx) error { return s.Devices.AuthorizeWithin(ctx, tx, a, "binding") }
		if write {
			budget := s.Resources
			if budget == nil {
				budget, _ = resourcebudget.New(nil, s.Now)
			}
			v, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.SubjectID}, authorize, func(context.Context, pgx.Tx) (any, error) { return fn(tx) }, resourcebudget.Options{})
			return object(v), e
		}
		if e := authorize(ctx, tx); e != nil {
			return nil, e
		}
		return fn(tx)
	})
}
func (s *Service) preferenceWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor) (Object, error) {
	r, e := row(ctx, tx, "SELECT to_jsonb(p) FROM personal_summary_preferences p WHERE subject_id=$1", a.SubjectID)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return Object{"revision": 0, "endpoint": s.Endpoint, "enabled": false, "roomIds": nil, "includeExisting": true, "enabledSince": nil, "audience": "owner-only", "expiresAfterInactiveDays": 30}, nil
	}
	return Object{"revision": r["revision"], "endpoint": r["endpoint"], "enabled": r["enabled"], "roomIds": r["room_ids"], "includeExisting": r["include_existing"], "enabledSince": iso(r["enabled_since"]), "audience": "owner-only", "expiresAfterInactiveDays": 30}, nil
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
		return nil, fail("summary_target_mismatch", 400)
	}
	return s.run(ctx, a, true, func(tx pgx.Tx) (Object, error) {
		if _, e := tx.Exec(ctx, "INSERT INTO personal_summary_preferences(subject_id,revision,endpoint,enabled,enabled_since,updated_at) VALUES($1,0,$2,false,$3,$3) ON CONFLICT DO NOTHING", a.SubjectID, s.Endpoint, stamp(s.now())); e != nil {
			return nil, e
		}
		r, e := row(ctx, tx, "SELECT to_jsonb(p) FROM personal_summary_preferences p WHERE subject_id=$1 FOR UPDATE", a.SubjectID)
		if e != nil {
			return nil, e
		}
		if number(r["revision"]) != number(x["expectedRevision"]) {
			return nil, fail("summary_preference_conflict")
		}
		enabledSince := any(stamp(s.now()))
		if r["enabled"] == true && x["enabled"] == true {
			enabledSince = r["enabled_since"]
		}
		if _, e = tx.Exec(ctx, "UPDATE personal_summary_preferences SET revision=revision+1,enabled=$2,room_ids=$3,include_existing=$4,enabled_since=$5,updated_at=$6 WHERE subject_id=$1", a.SubjectID, x["enabled"], x["roomIds"], x["includeExisting"], enabledSince, stamp(s.now())); e != nil {
			return nil, e
		}
		return s.preferenceWithin(ctx, tx, a)
	})
}

type filtered struct {
	Content, Persisted                     Object
	Invalidated, StorageChanged, Temporary bool
}

func filterContent(content Object, read func(Object) (Object, error)) (filtered, error) {
	if content["fragments"] == nil {
		return filtered{Content: Object{}}, nil
	}
	result, e := clone(content)
	if e != nil {
		return filtered{}, e
	}
	persisted, e := clone(content)
	if e != nil {
		return filtered{}, e
	}
	cache := map[string]Object{}
	check := func(ref Object) (Object, error) {
		key := str(ref, "messageId") + ":" + fmt.Sprint(ref["revision"])
		if status, ok := cache[key]; ok {
			return status, nil
		}
		status, e := read(ref)
		if e != nil {
			return nil, e
		}
		cache[key] = status
		return status, nil
	}
	fragments, refs, retainedFragments, retainedRefs := []any{}, []any{}, []any{}, []any{}
	for _, v := range array(result["fragments"]) {
		f := object(v)
		valid, permanent := true, false
		for _, v := range array(f["sourceRefs"]) {
			status, e := check(object(v))
			if e != nil {
				return filtered{}, e
			}
			if status["available"] != true {
				valid = false
				if status["temporarilyUnavailable"] != true {
					permanent = true
				}
			}
		}
		if valid {
			fragments = append(fragments, f)
		}
		if !permanent {
			retainedFragments = append(retainedFragments, f)
		}
	}
	for _, v := range array(result["keyMessageRefs"]) {
		status, e := check(object(v))
		if e != nil {
			return filtered{}, e
		}
		if status["available"] == true {
			refs = append(refs, v)
		}
		if status["available"] == true || status["temporarilyUnavailable"] == true {
			retainedRefs = append(retainedRefs, v)
		}
	}
	invalidated := len(fragments) != len(array(result["fragments"])) || len(refs) != len(array(result["keyMessageRefs"]))
	result["fragments"], result["keyMessageRefs"] = fragments, refs
	if invalidated {
		object(result["coverage"])["complete"] = false
	}
	changed := len(retainedFragments) != len(array(persisted["fragments"])) || len(retainedRefs) != len(array(persisted["keyMessageRefs"]))
	persisted["fragments"], persisted["keyMessageRefs"] = retainedFragments, retainedRefs
	if changed {
		object(persisted["coverage"])["complete"] = false
	}
	return filtered{Content: result, Persisted: persisted, Invalidated: invalidated, StorageChanged: changed, Temporary: len(fragments) < len(retainedFragments) || len(refs) < len(retainedRefs)}, nil
}
func (s *Service) filterWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, room string, content Object) (filtered, error) {
	if content["fragments"] != nil && s.Source == nil {
		return filtered{}, fail("summary_source_adapter_unavailable", 503)
	}
	return filterContent(content, func(ref Object) (Object, error) {
		if s.Source == nil {
			return nil, fail("summary_source_adapter_unavailable", 503)
		}
		q := Object{"roomId": room}
		for k, v := range ref {
			q[k] = v
		}
		return s.Source(ctx, tx, a, q)
	})
}
func (s *Service) viewWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, r Object, room string) (Object, error) {
	return s.viewWithFilter(ctx, tx, a.SubjectID, r, func(content Object) (filtered, error) { return s.filterWithin(ctx, tx, a, room, content) })
}
func (s *Service) viewWithFilter(ctx context.Context, tx pgx.Tx, subject string, r Object, filter func(Object) (filtered, error)) (Object, error) {
	if r == nil {
		return nil, nil
	}
	state := str(r, "state")
	content := object(r["content"])
	expires, e := parsedTime(r["expires_at"])
	if e != nil {
		return nil, e
	}
	if (state == "current" || state == "conflict") && !expires.After(time.Unix(s.now(), 0)) {
		if _, e = tx.Exec(ctx, "UPDATE personal_summary_versions SET state='expired',content='{}'::jsonb WHERE subject_id=$1 AND version_id=$2", subject, r["version_id"]); e != nil {
			return nil, e
		}
		state = "expired"
		content = Object{}
	}
	filtered, e := filter(content)
	if e != nil {
		return nil, e
	}
	if filtered.StorageChanged {
		if _, e = tx.Exec(ctx, "UPDATE personal_summary_versions SET content=$3 WHERE subject_id=$1 AND version_id=$2", subject, r["version_id"], filtered.Persisted); e != nil {
			return nil, e
		}
	}
	return Object{"versionId": r["version_id"], "summaryId": r["summary_id"], "revision": r["revision"], "baseRevision": r["base_revision"], "state": state, "content": filtered.Content, "sourceInvalidated": filtered.Invalidated, "sourcesTemporarilyUnavailable": filtered.Temporary, "updatedAt": iso(r["created_at"]), "expiresAt": iso(r["expires_at"])}, nil
}
