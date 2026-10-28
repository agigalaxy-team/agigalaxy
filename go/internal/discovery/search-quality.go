package discovery

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Actor = operationspermissions.Actor
type queryReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func rowObject(ctx context.Context, db queryReader, sql string, args ...any) (Object, error) {
	var raw []byte
	e := db.QueryRow(ctx, sql, args...).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var out Object
	e = decode(raw, &out)
	return out, e
}

type SearchQuality struct {
	Pool              *pgxpool.Pool
	Endpoint          string
	Authority         *operationspermissions.BusinessAuthority
	Meili             *Meilisearch
	OpenPanel         *OpenPanel
	Now               func() time.Time
	reconcileMu       sync.Mutex
	reconciling       map[string]*qualityFlight
	reconcileOwner    *SearchQuality
	preparedAuthorize func(context.Context, pgx.Tx) (Actor, error)
}
type qualityFlight struct {
	done chan struct{}
	row  Object
	err  error
}

func (q *SearchQuality) now() time.Time {
	if q.Now != nil {
		return q.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func (q *SearchQuality) metadata() Object {
	return Object{"checkedAt": q.now().Unix(), "readExpiresAt": q.now().Unix() + 30, "metadataOnly": true}
}
func qualityFailure(code string, status ...int) error {
	n := 409
	if len(status) > 0 {
		n = status[0]
	}
	return fault.New(code, n)
}
func errorCode(e error) string { return fault.Code(e) }
func (q *SearchQuality) require(ctx context.Context, tx pgx.Tx, actor Actor, action string) (Actor, error) {
	if q.Authority == nil {
		return Actor{}, qualityFailure("operations_authorization_unavailable", 503)
	}
	if q.preparedAuthorize != nil {
		fresh, e := q.preparedAuthorize(ctx, tx)
		if e != nil {
			return Actor{}, e
		}
		if fresh.ID != actor.ID || fresh.Endpoint != q.Endpoint {
			return Actor{}, qualityFailure("business_admin_denied", 403)
		}
		actor = fresh
	}
	fresh, e := q.Authority.RequireWithin(ctx, tx, actor, action)
	if e != nil {
		return Actor{}, e
	}
	if fresh.ID != actor.ID || fresh.Endpoint != q.Endpoint {
		return Actor{}, qualityFailure("business_admin_denied", 403)
	}
	return fresh, nil
}
func (q *SearchQuality) authorize(ctx context.Context, actor Actor, action string) (Actor, error) {
	tx, e := q.Pool.Begin(ctx)
	if e != nil {
		return Actor{}, e
	}
	defer tx.Rollback(context.Background())
	a, e := q.require(ctx, tx, actor, action)
	if e != nil {
		return a, e
	}
	return a, tx.Commit(ctx)
}
func (q *SearchQuality) state(ctx context.Context, db queryReader) (Object, error) {
	state, e := rowObject(ctx, db, "SELECT to_jsonb(s) FROM operations_search_quality_state_v1 s WHERE endpoint=$1", q.Endpoint)
	if state == nil && e == nil {
		return Object{"revision": int64(0), "active_id": nil, "draft_id": nil, "pending_operation": nil}, nil
	}
	return state, e
}
func (q *SearchQuality) version(ctx context.Context, db queryReader, id string) (Object, error) {
	if id == "" {
		return nil, nil
	}
	return rowObject(ctx, db, `SELECT to_jsonb(v)||jsonb_build_object('was_applied',EXISTS(SELECT 1 FROM operations_search_quality_operations_v1 o WHERE o.endpoint=v.endpoint AND o.version_id=v.id AND o.kind IN ('apply','restore') AND o.phase='applied')) FROM operations_search_quality_versions_v1 v WHERE v.endpoint=$1 AND v.id=$2`, q.Endpoint, id)
}
func (q *SearchQuality) operation(ctx context.Context, db queryReader, id string) (Object, error) {
	return rowObject(ctx, db, "SELECT to_jsonb(o) FROM operations_search_quality_operations_v1 o WHERE endpoint=$1 AND operation_id=$2", q.Endpoint, id)
}
func (q *SearchQuality) observedSettings(ctx context.Context) (Object, error) {
	if q.Meili == nil {
		return nil, fail("discovery_search_not_connected")
	}
	return q.Meili.Settings(ctx)
}
func (q *SearchQuality) lock(ctx context.Context, tx pgx.Tx) error {
	_, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912430))", q.Endpoint)
	return e
}
func number(o Object, key string) int64 { v, _ := integer(o[key]); return v }
func nullableString(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func qualityPhase(phase string) bool {
	return phase == "prepared" || phase == "submitting" || phase == "task-pending" || phase == "result-unknown"
}
func stamp(value any) any {
	switch v := value.(type) {
	case string:
		t, e := time.Parse(time.RFC3339Nano, v)
		if e == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	case time.Time:
		return v.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	return nil
}
func operationView(row Object, replayed bool) Object {
	if row == nil {
		return nil
	}
	return Object{"operationId": row["operation_id"], "kind": row["kind"], "versionId": row["version_id"], "phase": row["phase"], "errorCode": row["error_code"], "recordedAt": stamp(row["created_at"]), "updatedAt": stamp(row["updated_at"]), "replayed": replayed}
}
func versionView(row Object) Object {
	if row == nil {
		return nil
	}
	return Object{"id": row["id"], "version": row["version"], "settings": row["settings"], "kind": row["kind"], "createdAt": stamp(row["created_at"]), "operatorId": row["operator_id"], "restoredFrom": row["restored_from"], "restorable": str(row, "kind") == "baseline" || row["was_applied"] == true}
}
func merge(a, b Object) Object {
	for key, value := range b {
		a[key] = value
	}
	return a
}
func (q *SearchQuality) record(ctx context.Context, tx pgx.Tx, actor Actor, action, operation string, version int64) error {
	return q.recordFacts(ctx, tx, actor, action, operation, Object{"version": version}, Object{"version": version})
}
func (q *SearchQuality) recordFacts(ctx context.Context, tx pgx.Tx, actor Actor, action, operation string, selection, result Object) error {
	kind := "business-operator"
	var role any = actor.Role
	var contextValue, grant any
	if q.Authority != nil && q.Authority.Duty != nil && q.Authority.Duty.AcceptsDuty(actor) {
		metadata, e := q.Authority.Duty.DutyMetadata(actor)
		if e != nil {
			return e
		}
		kind = "operations-ai-service"
		role = nil
		bound := object(metadata["operation"])
		source := object(metadata["auditSource"])
		projection := Object{"schemaVersion": 1, "aiAccountId": metadata["aiAccountId"], "domain": metadata["domain"], "taskId": metadata["taskId"], "planId": metadata["planId"], "planVersion": metadata["planVersion"]}
		for _, key := range []string{"grantId", "grantVersion", "strategyId", "strategyVersionId"} {
			if bound[key] != nil {
				projection[key] = bound[key]
			}
		}
		if source["callId"] != nil {
			projection["toolCallId"] = source["callId"]
			projection["toolOperationId"] = source["operationId"]
			projection["judgmentKind"] = source["kind"]
		}
		contextValue = jsonString(projection)
		grant = bound["grantId"]
	}
	_, e := tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,operation_id,http_request_id,selection,result,created_at,actor_kind,grant_id,actor_context) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, uuid.NewString(), q.Endpoint, actor.ID, role, action, operation, actor.RequestID, jsonString(selection), jsonString(result), q.now(), kind, grant, contextValue)
	return e
}
