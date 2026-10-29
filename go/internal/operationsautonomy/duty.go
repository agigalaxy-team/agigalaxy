package operationsautonomy

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type DutyInput struct {
	Domain, AIAccountID, TaskID, Purpose, AccessPurpose, PlanID string
	PlanVersion                                                 int64
	DelegationVersion                                           *int64
	ResourceIDs                                                 []string
}
type dutyProof struct {
	owner        *Service
	input        DutyInput
	audit        Object
	operation    Object
	continuation bool
	stored       Object
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var schemaUUID = regexp.MustCompile(`(?i)^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$`)
var safeCode = regexp.MustCompile(`^[a-z][a-z0-9_.:-]{0,119}$`)

func dutyFail(code string) error { return fault.New(code, 403) }

func (s *Service) dutyAuthorizationWithin(ctx context.Context, tx pgx.Tx, input DutyInput, persisted bool) error {
	reference, e := s.taskWithin(ctx, tx, input.TaskID, "")
	if e != nil {
		return e
	}
	cfg, e := s.configWithin(ctx, tx, str(reference["domain"]), " FOR SHARE")
	if e != nil {
		return e
	}
	row, e := s.taskWithin(ctx, tx, input.TaskID, " FOR SHARE")
	if e != nil {
		return e
	}
	if row["domain"] != input.Domain || row["ai_account_id"] != input.AIAccountID || row["config_id"] != input.PlanID || num(row["plan_version"]) != input.PlanVersion || obj(row["configuration"])["purpose"] != input.Purpose {
		return fault.New("operations_autonomy_scope_denied", 403)
	}
	inactive := row["source"] == "workbench" || cfg["enabled"] != true || row["human_decision"] != nil
	if persisted {
		inactive = inactive || !has([]string{"running", "completed"}, str(row["state"]))
	} else {
		lease, _ := time.Parse(time.RFC3339Nano, str(row["lease_until"]))
		inactive = inactive || row["state"] != "running" || !lease.After(s.now())
	}
	if inactive {
		return fail("operations_autonomy_task_inactive")
	}
	return nil
}

// CurrentDutyWithin mints an opaque actor only after a real current task and
// fixed AI role match. A caller-supplied Actor or serialized metadata cannot mint it.
func (s *Service) CurrentDutyWithin(ctx context.Context, tx pgx.Tx, in DutyInput) (Actor, error) {
	if in.AccessPurpose == "" {
		in.AccessPurpose = "query"
	}
	if !has(domains, in.Domain) || !uuidPattern.MatchString(in.AIAccountID) || !uuidPattern.MatchString(in.TaskID) || !uuidPattern.MatchString(in.PlanID) || strings.Trim(in.Purpose, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff") == "" || protocol.TextLength(in.Purpose) > 120 || in.PlanVersion < 1 || in.PlanVersion > 9007199254740991 || !has([]string{"query", "prepare", "execution"}, in.AccessPurpose) || len(in.ResourceIDs) > 200 {
		return Actor{}, dutyFail("operations_agentos_scope_denied")
	}
	for _, id := range in.ResourceIDs {
		if !uuidPattern.MatchString(id) {
			return Actor{}, dutyFail("operations_agentos_scope_denied")
		}
	}
	in.ResourceIDs = append([]string{}, in.ResourceIDs...)
	if in.DelegationVersion != nil {
		v := *in.DelegationVersion
		in.DelegationVersion = &v
	}
	return s.currentDuty(ctx, tx, &dutyProof{owner: s, input: in})
}
func (s *Service) currentDuty(ctx context.Context, tx pgx.Tx, proof *dutyProof) (Actor, error) {
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912410))`, s.Endpoint); e != nil {
		return Actor{}, e
	}
	if proof.continuation {
		if _, e := s.validatePersistedWithin(ctx, tx, proof, nil, nil); e != nil {
			return Actor{}, e
		}
	} else if e := s.dutyAuthorizationWithin(ctx, tx, proof.input, false); e != nil {
		return Actor{}, e
	}
	if s.AIWork == nil {
		return Actor{}, fault.New("operations_ai_work_unavailable", 503)
	}
	in := proof.input
	current, e := s.AIWork.AuthorizationWithin(ctx, tx, in.Domain, &in.AIAccountID)
	if e != nil {
		return Actor{}, e
	}
	if !current.Enabled {
		return Actor{}, dutyFail("operations_ai_work_disabled")
	}
	return Actor{ID: "ai:" + current.AccountID, Endpoint: s.Endpoint, Role: "", Version: fmt.Sprintf("ai-service:%s:%d:%d", current.AccountID, current.AuthorizationVersion, in.PlanVersion), Permissions: operationsai.WorkPermissions(in.AccessPurpose, current.Permissions), Proof: proof}, nil
}
func (s *Service) proof(a Actor) (*dutyProof, error) {
	p, ok := a.Proof.(*dutyProof)
	if !ok || p == nil || p.owner != s || a.ID != "ai:"+p.input.AIAccountID || a.Endpoint != s.Endpoint || a.Role != "" || a.AIProof != nil {
		return nil, fault.New("business_admin_denied", 403)
	}
	return p, nil
}
func (s *Service) AcceptsDuty(a Actor) bool { _, e := s.proof(a); return e == nil }
func (s *Service) RequireDutyAction(ctx context.Context, tx pgx.Tx, a Actor, action, purpose string) (Actor, error) {
	p, e := s.proof(a)
	if e != nil {
		return Actor{}, e
	}
	copy := *p
	copy.input = p.input
	copy.input.ResourceIDs = append([]string{}, p.input.ResourceIDs...)
	if purpose != "" {
		if !has([]string{"query", "prepare", "execution"}, purpose) {
			return Actor{}, dutyFail("operations_agentos_scope_denied")
		}
		copy.input.AccessPurpose = purpose
	}
	fresh, e := s.currentDuty(ctx, tx, &copy)
	if e != nil {
		return Actor{}, e
	}
	if copy.input.AccessPurpose == "execution" && action != "workbench.read" {
		row, err := s.taskWithin(ctx, tx, copy.input.TaskID, "")
		if err != nil {
			return Actor{}, err
		}
		if obj(row["control_state"])["kind"] == "manual-pause" && has([]string{"requested", "paused"}, str(obj(row["control_state"])["phase"])) {
			return Actor{}, fault.New("operations_autonomy_pause_requested", 409)
		}
	}
	if action != "workbench.read" && !has(fresh.Permissions, action) {
		return Actor{}, fault.New("operations_permission_denied", 403)
	}
	return fresh, nil
}
func (s *Service) DutyMetadata(a Actor) (Object, error) {
	p, e := s.proof(a)
	if e != nil {
		return nil, e
	}
	in := p.input
	var delegation any
	if in.DelegationVersion != nil {
		delegation = *in.DelegationVersion
	}
	out := Object{"domain": in.Domain, "aiAccountId": in.AIAccountID, "taskId": in.TaskID, "purpose": in.Purpose, "accessPurpose": in.AccessPurpose, "planId": in.PlanID, "planVersion": in.PlanVersion, "delegationVersion": delegation, "resourceIds": append([]string{}, in.ResourceIDs...), "contextSchemaVersion": 1, "endpoint": s.Endpoint}
	if p.audit != nil {
		out["auditSource"] = clone(p.audit)
	}
	if p.operation != nil {
		out["operation"] = clone(p.operation)
	}
	return out, nil
}
func (s *Service) DutyForTaskWithin(ctx context.Context, tx pgx.Tx, id, purpose string) (Actor, error) {
	r, e := s.taskWithin(ctx, tx, id, "")
	if e != nil {
		return Actor{}, e
	}
	var delegation *int64
	if r["delegation_version"] != nil {
		v := num(r["delegation_version"])
		delegation = &v
	}
	cfg := obj(r["configuration"])
	return s.CurrentDutyWithin(ctx, tx, DutyInput{Domain: str(r["domain"]), AIAccountID: str(r["ai_account_id"]), TaskID: id, Purpose: str(cfg["purpose"]), AccessPurpose: purpose, PlanID: str(r["config_id"]), PlanVersion: num(r["plan_version"]), DelegationVersion: delegation, ResourceIDs: texts(obj(cfg["plan"])["resourceIds"])})
}
func (s *Service) BindDutyAuditSourceWithin(ctx context.Context, tx pgx.Tx, a Actor, callID, operationID string, nativeRunID *string, ruleSource bool) (Actor, error) {
	p, e := s.proof(a)
	if e != nil {
		return Actor{}, e
	}
	r, e := optional(ctx, tx, `SELECT to_jsonb(t) FROM(SELECT t.native_run_id,t.mode FROM operations_autonomy_tasks_v1 t JOIN operations_autonomy_tool_calls_v1 c ON c.endpoint=t.endpoint AND c.task_id=t.id WHERE t.endpoint=$1 AND t.id=$2 AND t.ai_account_id=$3 AND c.call_id=$4 AND c.operation_id=$5)t`, s.Endpoint, p.input.TaskID, p.input.AIAccountID, callID, operationID)
	if e != nil {
		return Actor{}, e
	}
	copy := *p
	copy.audit = nil
	kind := ""
	if r != nil && nativeRunID != nil && *nativeRunID != "" && r["native_run_id"] == *nativeRunID {
		kind = "ai"
	} else if r != nil && ruleSource && (nativeRunID == nil || *nativeRunID == "") && r["native_run_id"] == nil && r["mode"] == "code" {
		kind = "code"
	}
	if kind != "" {
		copy.audit = Object{"kind": kind, "callId": callID, "operationId": operationID}
	}
	return s.currentDuty(ctx, tx, &copy)
}
