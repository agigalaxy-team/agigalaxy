// Package businessadmin retains the original shared operations transaction,
// current authority, operation ledger and audit. Owning domains supply their
// existing action permissions and their real business operation callback.
package businessadmin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"time"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type Domain struct {
	Pool            *pgxpool.Pool
	Endpoint        string
	Authority       operationspermissions.Authority
	Duty            operationspermissions.DutyAuthority
	PrincipalWithin func(context.Context, pgx.Tx, Actor) error
	Permissions     func(string, Object) []string
	Now             func() time.Time
}

func fail(code string, status int) error { return fault.New(code, status) }
func str(x Object, k string) string      { v, _ := x[k].(string); return v }
func obj(x Object, k string) Object      { v, _ := x[k].(map[string]any); return v }
func encode(v any) []byte                { b, _ := protocol.Encode(v); return b }
func (d *Domain) now() int64 {
	if d.Now != nil {
		return d.Now().Unix()
	}
	return time.Now().Unix()
}
func (d *Domain) stamp() time.Time { return time.Unix(d.now(), 0) }
func (d *Domain) DutyAuthority() operationspermissions.DutyAuthority {
	if d.Duty != nil {
		return d.Duty
	}
	if a, ok := d.Authority.(*operationspermissions.BusinessAuthority); ok {
		return a.Duty
	}
	return nil
}
func (d *Domain) IsDuty(a Actor) bool {
	authority := d.DutyAuthority()
	return authority != nil && authority.AcceptsDuty(a)
}

func (d *Domain) executionAuthority(a Actor) operationspermissions.ExecutionAuthority {
	if authority, ok := d.Authority.(*operationspermissions.BusinessAuthority); ok && authority.Execution != nil && authority.Execution.AcceptsExecution(a) {
		return authority.Execution
	}
	return nil
}

func (d *Domain) IsExecution(a Actor) bool { return d.executionAuthority(a) != nil }
func (d *Domain) Fresh(ctx context.Context, tx pgx.Tx, a Actor, permission string) (Actor, error) {
	if d == nil || d.Authority == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	current, e := d.Authority.RequireWithin(ctx, tx, a, permission)
	if e != nil {
		return current, e
	}
	if current.ID != a.ID || current.Endpoint != d.Endpoint || a.Endpoint != d.Endpoint {
		return Actor{}, fail("business_admin_denied", 403)
	}
	return current, nil
}
func (d *Domain) Operation(ctx context.Context, tx pgx.Tx, a Actor, action string, selection Object) (Actor, error) {
	required := []string{}
	if d.Permissions != nil {
		required = d.Permissions(action, selection)
	}
	if len(required) == 0 {
		return Actor{}, fail("operations_permission_unknown", 403)
	}
	if execution := d.executionAuthority(a); execution != nil {
		fresh, err := execution.RequireExecutionOperation(ctx, tx, a, required, selection)
		if err != nil {
			return Actor{}, err
		}
		if err = execution.GuardOperationWithin(ctx, tx, fresh, action, selection); err != nil {
			return Actor{}, err
		}
		return fresh, nil
	}
	if d.IsDuty(a) {
		authority := &operationspermissions.BusinessAuthority{Human: d.Authority, Duty: d.DutyAuthority()}
		return authority.RequireOperationWithin(ctx, tx, a, required, selection, action)
	}
	current := a
	for _, permission := range required {
		var e error
		current, e = d.Fresh(ctx, tx, current, permission)
		if e != nil {
			return Actor{}, e
		}
	}
	return current, nil
}
func (d *Domain) Principal(ctx context.Context, tx pgx.Tx, a Actor) error {
	if execution := d.executionAuthority(a); execution != nil {
		_, err := execution.RecheckExecutionWithin(ctx, tx, a, false)
		return err
	}
	if d.IsDuty(a) {
		_, e := d.DutyAuthority().RequireDutyAction(ctx, tx, a, "workbench.read", "")
		return e
	}
	if d.PrincipalWithin == nil {
		return fail("operations_authorization_unavailable", 503)
	}
	return d.PrincipalWithin(ctx, tx, a)
}
func (d *Domain) Record(ctx context.Context, tx pgx.Tx, a Actor, action string, selection, result Object, operationID any) error {
	return d.record(ctx, tx, a, action, selection, result, operationID, nil)
}

// RecordAccountRead preserves the account-scoped read audit without creating a
// second actor-context encoder. The caller owns current read authorization.
func (d *Domain) RecordAccountRead(ctx context.Context, tx pgx.Tx, a Actor, action string, selection, result Object, accountID any) error {
	if action != "audit-read" && action != "user-read" && action != "users-query" {
		return fail("operations_permission_unknown", 403)
	}
	return d.record(ctx, tx, a, action, selection, result, nil, accountID)
}

// The owning account command has already checked the original operation in
// this transaction. Reuse the common attribution and immutable receipt writer.
func (d *Domain) RecordAccountOperation(ctx context.Context, tx pgx.Tx, a Actor, action string, selection, result Object, accountID, operationID any) error {
	switch action {
	case "restriction-set", "restriction-release", "type-change", "notice-delivery":
		return d.record(ctx, tx, a, action, selection, result, operationID, accountID)
	}
	return fail("operations_permission_unknown", 403)
}
func (d *Domain) record(ctx context.Context, tx pgx.Tx, a Actor, action string, selection, result Object, operationID, accountID any) error {
	kind := "business-operator"
	var role any = a.Role
	var actorContext any
	var executionID, grantID any
	operatorID := a.ID
	if execution := d.executionAuthority(a); execution != nil {
		metadata, err := execution.ExecutionMetadata(a)
		if err != nil {
			return err
		}
		id, _ := metadata["executionId"].(string)
		if _, err := uuid.Parse(id); err != nil || a.ID != "executor:"+id {
			return fail("business_admin_denied", 403)
		}
		executionID, grantID = id, metadata["grantId"]
		operatorID, role, kind = "executor:"+id, nil, "operations-executor"
	}
	if d.IsDuty(a) {
		kind = "operations-ai-service"
		role = nil
		metadata, e := d.DutyAuthority().DutyMetadata(a)
		if e != nil {
			return e
		}
		context := Object{"schemaVersion": 1, "aiAccountId": metadata["aiAccountId"], "domain": metadata["domain"], "taskId": metadata["taskId"], "planId": metadata["planId"], "planVersion": metadata["planVersion"]}
		bound, source := obj(metadata, "operation"), obj(metadata, "auditSource")
		grantID = bound["grantId"]
		for _, key := range []string{"grantId", "grantVersion", "strategyId", "strategyVersionId"} {
			if bound[key] != nil {
				context[key] = bound[key]
			}
		}
		if str(source, "callId") != "" {
			context["toolCallId"], context["toolOperationId"], context["judgmentKind"] = source["callId"], source["operationId"], source["kind"]
		}
		actorContext = encode(context)
	}
	_, e := tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context) VALUES($1,$2,$3,$4,$5,$13,$6,$7,$8,$9,$10,$11,$14,$15,$12)`, uuid.NewString(), d.Endpoint, operatorID, role, action, operationID, a.RequestID, encode(selection), encode(result), d.stamp(), kind, actorContext, accountID, executionID, grantID)
	return e
}
func (d *Domain) runWithin(ctx context.Context, tx pgx.Tx, a Actor, action string, selection Object, fn func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	if selection["id"] != nil {
		selection["resourceId"] = selection["id"]
	}
	current, e := d.Operation(ctx, tx, a, action, selection)
	if e != nil {
		return nil, e
	}
	if e = d.Principal(ctx, tx, current); e != nil {
		return nil, e
	}
	if selection["id"] != nil {
		selection["resourceId"] = selection["id"]
	}
	result, e := fn(tx, current)
	if e != nil {
		return nil, e
	}
	var count any
	if items, ok := result["items"].([]Object); ok {
		count = len(items)
	}
	if e = d.Record(ctx, tx, current, action, selection, Object{"count": count}, nil); e != nil {
		return nil, e
	}
	return result, nil
}
func (d *Domain) Run(ctx context.Context, a Actor, action string, selection Object, fn func(pgx.Tx, Actor) (Object, error), options ...pgx.TxOptions) (Object, error) {
	if len(options) == 0 {
		return postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Object, error) { return d.runWithin(ctx, tx, a, action, selection, fn) })
	}
	tx, e := d.Pool.BeginTx(ctx, options[0])
	if e != nil {
		return nil, e
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	result, e := d.runWithin(ctx, tx, a, action, selection, fn)
	if e != nil {
		return nil, e
	}
	e = tx.Commit(ctx)
	return result, e
}
func one(ctx context.Context, tx pgx.Tx, q string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, q, args...).Scan(&raw)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var x Object
	e = json.Unmarshal(raw, &x)
	return x, e
}
func (d *Domain) Command(ctx context.Context, a Actor, action string, selection Object, fn func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	return postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Object, error) {
		if selection["id"] != nil {
			selection["resourceId"] = selection["id"]
		}
		current, e := d.Operation(ctx, tx, a, action, selection)
		if e != nil {
			return nil, e
		}
		if e = d.Principal(ctx, tx, current); e != nil {
			return nil, e
		}
		if selection["id"] != nil {
			selection["resourceId"] = selection["id"]
		}
		operation := str(selection, "operationId")
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912391))", d.Endpoint+":operations:"+operation); e != nil {
			return nil, e
		}
		old, e := one(ctx, tx, "SELECT to_jsonb(a) FROM business_admin_audit_v1 a WHERE endpoint=$1 AND operation_id=$2", d.Endpoint, operation)
		if e != nil {
			return nil, e
		}
		if old != nil {
			left, e := identity.Canonical(old["selection"])
			if e != nil {
				return nil, e
			}
			right, e := identity.Canonical(selection)
			if e != nil {
				return nil, e
			}
			if str(old, "operator_id") != current.ID || str(old, "action") != action || string(left) != string(right) {
				return nil, fail("business_admin_operation_conflict", 409)
			}
			result := obj(old, "result")
			if result == nil {
				return nil, fmt.Errorf("invalid operation ledger")
			}
			result["replayed"] = true
			return result, nil
		}
		result, e := fn(tx, current)
		if e != nil {
			return nil, e
		}
		result["operationId"], result["recordedAt"] = operation, d.stamp().UTC().Format("2006-01-02T15:04:05.000Z")
		if e = d.Record(ctx, tx, current, action, selection, result, operation); e != nil {
			return nil, e
		}
		return result, nil
	})
}
