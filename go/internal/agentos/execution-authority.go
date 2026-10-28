package agentos

import (
	"context"
	"slices"
	"strconv"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ExecutionSourceRef struct {
	Kind, ID string
	Version  int64
}
type ExecutionRecord struct {
	ID, GrantID, Domain, ExecutorKind, Mode, CreatedBy, State, SessionID string
	GrantVersion, Revision                                               int64
	OperatorID, AIAccountID                                              *string
	Actions, ResourceIDs                                                 []string
	PreparedCommand                                                      Object
	CreatedAt, UpdatedAt                                                 time.Time
}

const executionColumns = `id::text,grant_id::text,grant_version,domain,executor_kind,mode,operator_id,created_by,actions,resource_ids::text[],state,revision,session_id::text,prepared_command,created_at,updated_at,ai_account_id::text`

// Executions retains the original durable grant-bound execution authority.
// Supported actions are actual server consumers, never model declarations.
type Executions struct {
	Pool          *pgxpool.Pool
	Endpoint      string
	Permissions   *operationspermissions.Service
	Supported     []string
	QualifyWithin func(context.Context, pgx.Tx, string, []string, []string) ([]ExecutionSourceRef, error)
	Now           func() time.Time
}
type executionProof struct {
	owner     *Executions
	id        string
	resources []string
	caller    *operationspermissions.Actor
	metadata  Object
}
type ExecutionActorOptions struct {
	ResourceIDs  []string
	InactiveRead bool
	From         *operationspermissions.Actor
	Caller       *operationspermissions.Actor
}

func (s *Executions) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}
func executionStrings(value any) []string {
	switch a := value.(type) {
	case []string:
		return append([]string{}, a...)
	case []any:
		out := []string{}
		for _, v := range a {
			if x, ok := v.(string); ok {
				out = append(out, x)
			}
		}
		return out
	}
	return []string{}
}
func executionSubset(values, allowed []string) bool {
	for _, v := range values {
		if !slices.Contains(allowed, v) {
			return false
		}
	}
	return true
}
func executionNumber(o Object, key string) int64 { v, _ := index(o[key]); return v }
func executionHumanOnly(code string) bool {
	for _, entry := range operationspermissions.CatalogMetadata() {
		if entry["code"] == code {
			return entry["humanOnly"] == true
		}
	}
	return true
}
func (s *Executions) supported(code string) bool {
	return slices.Contains([]string{"content.read", "content.hide", "content.restore"}, code) || slices.Contains(s.Supported, code)
}
func (s *Executions) ready() error {
	if s == nil || s.Pool == nil || s.Permissions == nil {
		return fail("operations_authorization_unavailable", 503)
	}
	return nil
}
func (s *Executions) proof(a operationspermissions.Actor) (*executionProof, bool) {
	if s == nil {
		return nil, false
	}
	p, ok := a.Proof.(*executionProof)
	return p, ok && p != nil && p.owner == s && a.ID == "executor:"+p.id && a.Endpoint == s.Endpoint && a.Role == "" && a.AIProof == nil
}
func (s *Executions) AcceptsExecution(a operationspermissions.Actor) bool {
	_, ok := s.proof(a)
	return ok
}
func (s *Executions) ExecutionMetadata(a operationspermissions.Actor) (Object, error) {
	p, ok := s.proof(a)
	if !ok {
		return nil, fail("business_admin_denied", 403)
	}
	out := Object{}
	for k, v := range p.metadata {
		out[k] = v
	}
	out["resourceIds"] = append([]string{}, p.resources...)
	return out, nil
}
func (s *Executions) read(ctx context.Context, tx pgx.Tx, id string, lock bool) (*ExecutionRecord, error) {
	var r ExecutionRecord
	tail := ""
	if lock {
		tail = " FOR SHARE"
	}
	e := tx.QueryRow(ctx, `SELECT `+executionColumns+` FROM operations_agentos_executions_v1 WHERE endpoint=$1 AND id=$2`+tail, s.Endpoint, id).Scan(&r.ID, &r.GrantID, &r.GrantVersion, &r.Domain, &r.ExecutorKind, &r.Mode, &r.OperatorID, &r.CreatedBy, &r.Actions, &r.ResourceIDs, &r.State, &r.Revision, &r.SessionID, &r.PreparedCommand, &r.CreatedAt, &r.UpdatedAt, &r.AIAccountID)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	return &r, e
}
func (s *Executions) caller(id string, opts ExecutionActorOptions) (*operationspermissions.Actor, error) {
	caller := opts.Caller
	if opts.From != nil {
		p, ok := s.proof(*opts.From)
		if !ok || p.id != id {
			return nil, fail("business_admin_denied", 403)
		}
		if caller != nil && (p.caller == nil || !sameExecutionCaller(*caller, *p.caller)) {
			return nil, fail("business_admin_denied", 403)
		}
		caller = p.caller
	}
	if caller != nil {
		if _, e := s.Permissions.AIWorkContext(*caller); e != nil {
			return nil, fail("business_admin_denied", 403)
		}
	}
	return caller, nil
}
func sameExecutionCaller(a, b operationspermissions.Actor) bool {
	return a.ID == b.ID && a.Proof == b.Proof && a.AIProof == b.AIProof
}
func (s *Executions) currentWithin(ctx context.Context, tx pgx.Tx, id string, opts ExecutionActorOptions) (*ExecutionRecord, []string, *operationspermissions.Actor, error) {
	if e := s.ready(); e != nil {
		return nil, nil, nil, e
	}
	caller, e := s.caller(id, opts)
	if e != nil {
		return nil, nil, nil, e
	}
	if _, e = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))`, s.Endpoint); e != nil {
		return nil, nil, nil, e
	}
	row, e := s.read(ctx, tx, id, true)
	if e != nil {
		return nil, nil, nil, e
	}
	if row == nil || row.State == "stopped" || !opts.InactiveRead && row.State != "active" {
		return nil, nil, nil, fail("operations_agentos_execution_inactive", 409)
	}
	var grant Object
	e = tx.QueryRow(ctx, `SELECT to_jsonb(g) FROM operations_automation_grants_v1 g WHERE endpoint=$1 AND id=$2`, s.Endpoint, row.GrantID).Scan(&grant)
	if e != nil && e != pgx.ErrNoRows {
		return nil, nil, nil, e
	}
	if grant == nil || grant["enabled"] != true || executionNumber(grant, "version") != row.GrantVersion || grant["mode"] != row.Mode || grant["executor_kind"] != row.ExecutorKind {
		return nil, nil, nil, fail("operations_agentos_authority_changed", 403)
	}
	scope := operationspermissions.AutomationResourceScope(grant)
	if scope["kind"] == "unresolved" && len(row.Actions) > 0 {
		return nil, nil, nil, fail("operations_agentos_scope_unresolved", 403)
	}
	if scope["kind"] == "selected" && !executionSubset(row.ResourceIDs, executionStrings(scope["resourceIds"])) {
		return nil, nil, nil, fail("operations_agentos_scope_denied", 403)
	}
	for _, code := range row.Actions {
		if executionHumanOnly(code) || !s.supported(code) {
			return nil, nil, nil, fail("operations_agentos_action_unavailable", 403)
		}
	}
	allowed := []string{}
	for _, code := range executionStrings(grant["permissions"]) {
		if slices.Contains(row.Actions, code) {
			allowed = append(allowed, code)
		}
	}
	if row.ExecutorKind == "ai" {
		if s.Permissions.AIWork == nil {
			return nil, nil, nil, fail("operations_ai_work_unavailable", 503)
		}
		if row.AIAccountID == nil || grant["ai_account_id"] != *row.AIAccountID {
			return nil, nil, nil, fail("operations_ai_work_unassigned", 403)
		}
		current, e := s.Permissions.AIWork.ExecutionRoleWithin(ctx, tx, row.Domain, *row.AIAccountID, row.Actions)
		if e != nil {
			return nil, nil, nil, e
		}
		allowed = executionIntersection(allowed, current.Permissions)
	}
	if row.Mode == "assisted" {
		if row.OperatorID == nil || s.Permissions.StoredAuthority == nil {
			return nil, nil, nil, fail("operations_authorization_unavailable", 503)
		}
		person, e := s.Permissions.StoredAuthority.PersonWithin(ctx, tx, *row.OperatorID, false)
		if e != nil {
			return nil, nil, nil, e
		}
		if !slices.Contains(person.Permissions, "workbench.read") {
			return nil, nil, nil, fail("operations_permission_denied", 403)
		}
		if row.ExecutorKind == "ai" && !slices.Contains(person.Permissions, "ai.use."+row.Domain) {
			return nil, nil, nil, fail("operations_agentos_ai_use_denied", 403)
		}
		allowed = executionIntersection(allowed, person.Permissions)
	}
	if caller != nil {
		metadata, e := s.Permissions.AIWorkContext(*caller)
		if e != nil {
			return nil, nil, nil, e
		}
		if row.ExecutorKind != "ai" || row.AIAccountID == nil || metadata["accountId"] != *row.AIAccountID {
			return nil, nil, nil, fail("operations_ai_work_unassigned", 403)
		}
		current, e := s.Permissions.HumanAIWithin(ctx, tx, *caller, row.Domain, "execution", "workbench.read")
		if e != nil {
			return nil, nil, nil, e
		}
		allowed = executionIntersection(allowed, current.Permissions)
	}
	if !executionSubset(row.Actions, allowed) {
		return nil, nil, nil, fail("operations_agentos_authority_changed", 403)
	}
	if scope["kind"] == "eligible" && len(row.Actions) > 0 {
		if s.QualifyWithin == nil {
			return nil, nil, nil, fail("operations_agentos_scope_unavailable", 503)
		}
		refs, e := s.QualifyWithin(ctx, tx, row.Domain, row.Actions, row.ResourceIDs)
		if e != nil {
			return nil, nil, nil, e
		}
		for _, ref := range refs {
			var matched bool
			if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_agentos_source_refs_v1 WHERE execution_id=$1 AND target_kind=$2 AND target_id=$3 AND source_version=$4)`, row.ID, ref.Kind, ref.ID, ref.Version).Scan(&matched); e != nil {
				return nil, nil, nil, e
			}
			if !matched {
				return nil, nil, nil, fail("operations_agentos_source_changed", 409)
			}
		}
	}
	return row, allowed, caller, nil
}
func executionIntersection(values, allowed []string) []string {
	out := []string{}
	for _, v := range values {
		if slices.Contains(allowed, v) {
			out = append(out, v)
		}
	}
	return out
}
func (s *Executions) ActorWithin(ctx context.Context, tx pgx.Tx, id string, opts ExecutionActorOptions) (operationspermissions.Actor, error) {
	row, allowed, caller, e := s.currentWithin(ctx, tx, id, opts)
	if e != nil {
		return operationspermissions.Actor{}, e
	}
	resources := row.ResourceIDs
	if opts.ResourceIDs != nil {
		if len(opts.ResourceIDs) == 0 || !executionSubset(opts.ResourceIDs, resources) {
			return operationspermissions.Actor{}, fail("operations_agentos_scope_denied", 403)
		}
		resources = opts.ResourceIDs
	}
	metadata := Object{"executionId": row.ID, "grantId": row.GrantID, "executorKind": row.ExecutorKind, "mode": row.Mode, "domain": row.Domain, "onBehalfOf": nil}
	if row.OperatorID != nil {
		metadata["onBehalfOf"] = *row.OperatorID
	}
	var copiedCaller *operationspermissions.Actor
	if caller != nil {
		copy := *caller
		copy.Permissions = append([]string{}, caller.Permissions...)
		copiedCaller = &copy
	}
	return operationspermissions.Actor{ID: "executor:" + row.ID, Endpoint: s.Endpoint, Version: strconv.FormatInt(row.GrantVersion, 10), Permissions: append([]string{}, allowed...), Proof: &executionProof{s, row.ID, append([]string{}, resources...), copiedCaller, metadata}}, nil
}
func (s *Executions) Actor(ctx context.Context, id string, opts ExecutionActorOptions) (operationspermissions.Actor, error) {
	if e := s.ready(); e != nil {
		return operationspermissions.Actor{}, e
	}
	if !validOperationID(id) {
		return operationspermissions.Actor{}, fail("invalid_operations_agentos_request", 400)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) { return s.ActorWithin(ctx, tx, id, opts) })
}
func (s *Executions) RequireExecutionAction(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, action string) (operationspermissions.Actor, error) {
	p, ok := s.proof(a)
	if !ok || action != "" && (!s.supported(action) || executionHumanOnly(action)) {
		return operationspermissions.Actor{}, fail("business_admin_denied", 403)
	}
	fresh, e := s.ActorWithin(ctx, tx, p.id, ExecutionActorOptions{ResourceIDs: append([]string{}, p.resources...), InactiveRead: action == "content.read", From: &a})
	if e != nil {
		return fresh, e
	}
	if action != "" && !slices.Contains(fresh.Permissions, action) {
		return operationspermissions.Actor{}, fail("operations_permission_denied", 403)
	}
	return fresh, nil
}

func (s *Executions) RecheckExecutionWithin(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, active bool) (operationspermissions.Actor, error) {
	p, ok := s.proof(a)
	if !ok {
		return operationspermissions.Actor{}, fail("business_admin_denied", 403)
	}
	return s.ActorWithin(ctx, tx, p.id, ExecutionActorOptions{ResourceIDs: append([]string{}, p.resources...), InactiveRead: !active, From: &a})
}
func (s *Executions) RequireExecutionOperation(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, required []string, selection Object) (operationspermissions.Actor, error) {
	p, ok := s.proof(a)
	if !ok {
		return operationspermissions.Actor{}, fail("business_admin_denied", 403)
	}
	ids := []string{}
	for _, key := range []string{"id", "resourceId", "accountId"} {
		if id := text(selection, key); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 || !executionSubset(ids, p.resources) {
		return operationspermissions.Actor{}, fail("operations_agentos_scope_denied", 403)
	}
	fresh := a
	for _, code := range required {
		var e error
		fresh, e = s.RequireExecutionAction(ctx, tx, fresh, code)
		if e != nil {
			return fresh, e
		}
	}
	return fresh, nil
}

// Qualifier composes only owning current-source readers and never adds an ID
// to the task's frozen scope. Ordinary strategy qualification is separate.
func QualifyExecutionSources(public func(context.Context, pgx.Tx, string) (Object, error), ordinary func(context.Context, pgx.Tx, string, []string) (bool, error)) func(context.Context, pgx.Tx, string, []string, []string) ([]ExecutionSourceRef, error) {
	return func(ctx context.Context, tx pgx.Tx, domain string, actions, ids []string) ([]ExecutionSourceRef, error) {
		if domain != "governance" || len(actions) == 0 {
			return nil, fail("operations_agentos_action_unavailable", 403)
		}
		for _, code := range actions {
			if !operationsai.Autonomous(code) {
				return nil, fail("operations_agentos_action_unavailable", 403)
			}
		}
		if len(ids) == 0 {
			return nil, fail("operations_agentos_scope_required", 400)
		}
		content, strategy := false, false
		for _, code := range actions {
			content = content || len(code) >= 8 && code[:8] == "content."
			strategy = strategy || len(code) >= 11 && code[:11] == "strategies."
		}
		refs := []ExecutionSourceRef{}
		for _, id := range ids {
			if content {
				if public == nil {
					return nil, fail("operations_agentos_scope_unavailable", 503)
				}
				v, e := public(ctx, tx, id)
				if e != nil {
					return nil, e
				}
				if v != nil {
					version, ok := index(v["version"])
					if !ok || version < 1 || !slices.Contains([]string{"post", "reply"}, text(v, "kind")) || text(v, "id") != id {
						return nil, fail("operations_agentos_scope_unavailable", 503)
					}
					refs = append(refs, ExecutionSourceRef{text(v, "kind"), id, version})
					continue
				}
			}
			if strategy {
				if ordinary == nil {
					return nil, fail("operations_agentos_scope_unavailable", 503)
				}
				yes, e := ordinary(ctx, tx, id, actions)
				if e != nil {
					return nil, e
				}
				if yes {
					continue
				}
			}
			return nil, fail("operations_agentos_object_ineligible", 403)
		}
		return refs, nil
	}
}
