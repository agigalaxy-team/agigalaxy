package businessadmin

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"time"
)

func number(v any) int64 {
	switch x := v.(type) {
	case int:
		return int64(x)
	case int64:
		return x
	case float64:
		return int64(x)
	case json.Number:
		n, _ := x.Int64()
		return n
	}
	return 0
}
func timestamp(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t
	}
	s, _ := v.(string)
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}
func iso(v any) any {
	if v == nil {
		return nil
	}
	return timestamp(v).UTC().Format("2006-01-02T15:04:05.000Z")
}

// VisibilityWithin reads only the original operator restriction layer.
func VisibilityWithin(ctx context.Context, tx pgx.Tx, endpoint, kind, id string, now int64) (Object, error) {
	r, e := one(ctx, tx, "SELECT to_jsonb(v) FROM operations_content_visibility_v1 v WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3", endpoint, kind, id)
	if e != nil {
		return nil, e
	}
	return Object{"version": number(r["revision"]), "hidden": r["hidden_until"] != nil && timestamp(r["hidden_until"]).Unix() > now, "until": iso(r["hidden_until"]), "operationId": r["operation_id"]}, nil
}

// ChangeVisibilityWithin is the original common section/resource/content CAS.
// Owning callbacks must first lock and qualify their real source in this tx.
func (d *Domain) ChangeVisibilityWithin(ctx context.Context, tx pgx.Tx, kind, id string, expectedVersion, sourceVersion int64, input Object, maxHideSeconds int64) (Object, error) {
	if expectedVersion != sourceVersion {
		return nil, fail("operations_source_changed", 409)
	}
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912392))", d.Endpoint+":"+kind+":"+id); e != nil {
		return nil, e
	}
	old, e := VisibilityWithin(ctx, tx, d.Endpoint, kind, id, d.now())
	if e != nil {
		return nil, e
	}
	if number(old["version"]) != number(input["expectedVisibilityVersion"]) {
		return nil, fail("operations_visibility_changed", 409)
	}
	if maxHideSeconds < 1 {
		return nil, fail("operations_policy_unavailable", 503)
	}
	hide := str(input, "kind") == "hide"
	if hide && (number(input["until"]) <= d.now() || number(input["until"]) > d.now()+maxHideSeconds) {
		return nil, fail("operations_hide_expiry", 400)
	}
	hidden, _ := old["hidden"].(bool)
	if !hide && !hidden {
		return nil, fail("operations_visibility_changed", 409)
	}
	var until any
	if hide {
		until = time.Unix(number(input["until"]), 0).UTC()
	}
	revision := number(old["version"]) + 1
	_, e = tx.Exec(ctx, `INSERT INTO operations_content_visibility_v1(endpoint,target_kind,target_id,revision,hidden_until,operation_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(endpoint,target_kind,target_id) DO UPDATE SET revision=EXCLUDED.revision,hidden_until=EXCLUDED.hidden_until,operation_id=EXCLUDED.operation_id,updated_at=EXCLUDED.updated_at`, d.Endpoint, kind, id, revision, until, input["operationId"], d.stamp())
	return Object{"target": Object{"kind": kind, "id": id}, "sourceVersion": sourceVersion, "visibility": Object{"version": revision, "hidden": hide, "until": iso(until), "operationId": input["operationId"]}, "sourcePermissionChanged": false}, e
}
