package information

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"sort"
	"time"
)

type ResourceWrite func(context.Context, pgx.Tx, deviceauth.Actor, bool, func() error, func() (Object, error)) (Object, error)

// WatchProducer is attached only for an explicitly configured Go scheduler.
// key is the original watch:<id>:<revision>:<checkRevision> operation key.
type WatchProducer func(context.Context, pgx.Tx, string, Object, time.Time) error
type WatchOutstanding func(context.Context, pgx.Tx, string, int64, int64) (bool, error)
type Watches struct {
	Pool                                     *pgxpool.Pool
	Devices                                  *deviceauth.Service
	Information                              *Service
	Now                                      func() time.Time
	ResourceWrite                            ResourceWrite
	Tasks                                    WatchProducer
	HasOutstanding                           WatchOutstanding
	CanProcessEvidence, CanProcessBackground func() bool
}

func (s *Watches) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Watches) at(n int64) time.Time { return time.Unix(n, 0).UTC() }
func (s *Watches) run(ctx context.Context, a deviceauth.Actor, write, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if s.Pool == nil || s.Devices == nil {
		return nil, fault.New("information_watch_unavailable", 503)
	}
	if write {
		if e := deviceauth.CheckInformationWatchWrite(a, "notifications"); e != nil {
			return nil, e
		}
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func() error {
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, a, "notifications")
			return e
		}
		op := func() (Object, error) { return fn(tx, auth) }
		if write && s.ResourceWrite != nil {
			return s.ResourceWrite(ctx, tx, a, control, authorize, op)
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return op()
	})
}
func query(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		values, e := rows.Values()
		if e != nil {
			return nil, e
		}
		o := Object{}
		for i, f := range rows.FieldDescriptions() {
			v := values[i]
			if f.DataTypeOID == 3802 || f.DataTypeOID == 114 {
				if raw, ok := v.([]byte); ok {
					v, e = protocol.DecodeOrdered(raw)
					if e != nil {
						return nil, e
					}
				} else {
					raw, e := json.Marshal(v)
					if e != nil {
						return nil, e
					}
					v, e = protocol.DecodeOrdered(raw)
					if e != nil {
						return nil, e
					}
				}
			}
			o[f.Name] = v
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// The database supplies JSONB in its own member order. Fetch it as text rather
// than decoding into a map before the bounded scan/receipt projection.
const watchColumns = `id::text,subject_id,revision,check_revision,state,plan::text AS plan_text,expires_at,baseline::text AS baseline_text,scan::text AS scan_text,last_checked_at,next_check_at,failures,created_at,updated_at,ended_at,background_authority::text AS authority_text,background_state,background_error`

func decodeWatch(r Object) (Object, error) {
	if r == nil {
		return nil, nil
	}
	for _, pair := range [][2]string{{"plan_text", "plan"}, {"baseline_text", "baseline"}, {"scan_text", "scan"}, {"authority_text", "background_authority"}} {
		var v any
		if value, ok := r[pair[0]].(string); ok {
			var e error
			v, e = protocol.DecodeOrdered([]byte(value))
			if e != nil {
				return nil, e
			}
		}
		r[pair[1]] = v
		delete(r, pair[0])
	}
	return r, nil
}
func (s *Watches) rowWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string, lock bool) (Object, error) {
	sql := `SELECT ` + watchColumns + ` FROM information_watches_v2 WHERE id=$1 AND subject_id=$2`
	if lock {
		sql += ` FOR UPDATE`
	}
	rows, e := query(ctx, tx, sql, id, a.SubjectID)
	if e != nil {
		return nil, e
	}
	if len(rows) == 0 {
		return nil, fault.New("information_watch_not_found", 404)
	}
	return decodeWatch(rows[0])
}
func seconds(v any) int64 {
	if at, ok := v.(time.Time); ok {
		return at.Unix()
	}
	return 0
}
func entries(v any) []string {
	if o, ok := v.(*ordered); ok {
		return o.Keys()
	}
	keys := []string{}
	for k := range obj(v) {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
func (s *Watches) runtime(r Object) Object {
	background := s.Tasks != nil && (r == nil || r["state"] == "active" && seconds(r["expires_at"]) > s.now() && r["background_authority"] != nil && r["background_state"] != "authorization-required")
	scheduled := "user-host"
	if background {
		scheduled = "galaxy-service"
	}
	return Object{"scheduledBy": scheduled, "cloudModel": false, "continuesAfterHostExit": background, "modelCalls": 0}
}
func merge(dst, src Object) Object {
	for k, v := range src {
		dst[k] = v
	}
	return dst
}
func (s *Watches) view(r Object) Object {
	state := r["state"]
	if state == "active" && seconds(r["expires_at"]) <= s.now() {
		state = "expired"
	}
	var last, next any
	if r["last_checked_at"] != nil {
		last = seconds(r["last_checked_at"])
	}
	if r["next_check_at"] != nil {
		next = seconds(r["next_check_at"])
	}
	coverage := []any{}
	scan := obj(r["scan"])
	for _, key := range entries(r["scan"]) {
		v := obj(scan[key])
		coverage = append(coverage, Object{"key": key, "complete": v["complete"] == true, "continuationAvailable": text(v, "after") != "", "state": coalesce(v["state"], "not-checked")})
	}
	host, bg := r["background_state"], r["background_state"]
	if s.Tasks == nil {
		host = "last-check-only; host-running-state-not-confirmed"
		bg = "not-configured"
	}
	return merge(Object{"watchId": r["id"], "revision": r["revision"], "state": state, "plan": r["plan"], "lastCheckedAt": last, "nextCheckAt": next, "sourceCoverage": coverage, "hostRuntimeState": host, "backgroundState": bg}, s.runtime(r))
}
func (s *Watches) queueWithin(ctx context.Context, tx pgx.Tx, r Object) error {
	if s.Tasks == nil || r["state"] != "active" || r["background_authority"] == nil || r["background_state"] == "authorization-required" || seconds(r["expires_at"]) <= s.now() {
		return nil
	}
	at := s.at(s.now())
	if v, ok := r["next_check_at"].(time.Time); ok {
		at = v
	}
	key := fmt.Sprintf("watch:%s:%d:%d", text(r, "id"), number(r, "revision"), number(r, "check_revision"))
	return s.Tasks(ctx, tx, key, Object{"watchId": r["id"], "subjectId": r["subject_id"], "revision": number(r, "revision"), "checkRevision": number(r, "check_revision")}, at)
}
func (s *Watches) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, id, operation, requestID string) error {
	if !contains(auth.CredentialScopes, "notifications") {
		return fmt.Errorf("notification audit authorization unavailable")
	}
	var rid any
	if requestID != "" {
		rid = requestID
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,'notification.preferences',$2::text,$3::text,'accepted',1,ch.payload->>'installationId',b.audience,'notifications',b.id,$4::uuid,$3::text,b.scopes,$5::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$6::uuid AND b.subject_id=$1 AND b.scopes ? 'notifications'`, a.SubjectID, id, "information-watch:"+operation, rid, string(encode(auth.CredentialScopes)), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fault.New("notification_audit_unavailable", 503)
	}
	return nil
}
func contains(values []string, key string) bool {
	for _, v := range values {
		if v == key {
			return true
		}
	}
	return false
}
