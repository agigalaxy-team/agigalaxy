package actions

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"slices"
	"time"
)

func (s *Service) priorDutyWithin(ctx context.Context, tx pgx.Tx, a Actor, request Object, grantID string) error {
	actions := map[string][]string{"feedback-update": {"feedback-update"}, "account-restriction": {"restriction-set", "restriction-release"}, "content-visibility": {"community-content-visibility", "community-content-batch-visibility"}, "content-curation": {"community-content-curation"}, "file-access": {"file-access-stop", "file-access-restore"}, "section-classification": {"community-section-classify"}, "section-visibility": {"community-section-visibility"}, "resource-visibility": {"resource-visibility"}, "case-resolve": {"community-report-resolve"}}[str(request["kind"])]
	if len(actions) == 0 {
		switch str(request["kind"]) {
		case "recommendation-direction":
			actions = []string{"recommendations.configure"}
		case "search-apply", "search-restore":
			actions = []string{"search-quality.publish", "search-quality.restore"}
		case "messaging-state":
			actions = []string{"notice-publish", "notice-withdraw"}
		default:
			return nil
		}
	}
	id := request["targetId"]
	if id == nil {
		id = request["versionId"]
	}
	var kind, owner string
	var grant *string
	e := tx.QueryRow(ctx, `SELECT actor_kind,operator_id,grant_id::text FROM business_admin_audit_v1 WHERE endpoint=$1 AND action=ANY($2::text[]) AND ($3::text IS NULL OR account_id::text=$3 OR selection->>'id'=$3 OR selection->>'resourceId'=$3 OR selection->>'planId'=$3 OR selection->'items' @> jsonb_build_array(jsonb_build_object('id',$3::text))) ORDER BY sequence DESC LIMIT 1`, s.Endpoint, actions, id).Scan(&kind, &owner, &grant)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	if kind != "operations-ai-service" || owner != a.ID || grant == nil || *grant != grantID {
		return fail("operations_agentos_human_review_required", 409)
	}
	return nil
}
func (s *Service) QualifyTargetWithin(ctx context.Context, tx pgx.Tx, a Actor, permission, targetID string, request, command Object, grantID string) error {
	x, e := ParseRequest(request)
	if e != nil {
		return e
	}
	if required(x) != permission || !s.ActionReady(permission) {
		return fail("operations_agentos_action_not_connected", 503)
	}
	kind := str(x["kind"])
	selectedID := x["targetId"]
	if kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-publish" {
		selectedID = x["strategyId"]
	}
	if kind == "ordinary-strategy-create-draft" {
		selectedID = x["sourceStrategyId"]
	}
	if kind == "recommendation-direction" {
		selectedID = x["themeKey"]
	}
	if kind == "search-apply" || kind == "search-restore" {
		selectedID = command["versionId"]
	}
	if kind == "search-draft-save" {
		selectedID = command["expectedDraftId"]
		if selectedID == nil {
			metadata, err := s.Permissions.Duty.DutyMetadata(a)
			if err != nil {
				return err
			}
			selectedID = obj(metadata["operation"])["operationId"]
			// During initial grant qualification the operation has not yet
			// been bound; Prepare created this target from its operation ID.
			if selectedID == nil {
				selectedID = targetID
			}
		}
	}
	if kind == "message-draft-create" {
		selectedID = command["planId"]
	}
	if kind == "private-case-message" {
		selectedID = x["reportId"]
	}
	if kind != "public-content-batch" && selectedID != targetID {
		return fail("operations_agentos_scope_denied", 403)
	}
	switch kind {
	case "ordinary-strategy-draft", "ordinary-strategy-create-draft", "ordinary-strategy-publish":
		service, err := s.strategies(a)
		if err != nil {
			return err
		}
		_, head, version, strategy, err := service.InspectOrdinaryWithin(ctx, tx, a, str(selectedID))
		if err != nil {
			return err
		}
		if head["paused"] == true || strategy["ordinaryBounds"] == nil || strategy["mode"] == "human-led" {
			return fail("operations_agentos_human_review_required", 409)
		}
		if kind == "ordinary-strategy-create-draft" {
			if obj(strategy["ordinaryBounds"])["canCreate"] != true || version["id"] != x["sourceVersionId"] || num(head["revision"]) != num(x["expectedRevision"]) || head["draft_id"] != nil {
				return fail("operations_agentos_human_review_required", 409)
			}
			if _, err := operationsstrategies.OrdinaryCreation(obj(version["configuration"]), x, "ffffffff-ffff-ffff-ffff-ffffffffffff"); err != nil {
				return err
			}
		}
	case "search-draft-save", "search-apply", "search-restore", "recommendation-direction":
		if kind == "search-draft-save" {
			service, err := s.searchQuality(a, nil)
			if err != nil {
				return err
			}
			return service.QualifyPreparedDraftWithin(ctx, tx, a, command, targetID, grantID)
		}
		if err := s.qualifyDiscoveryWithin(ctx, tx, a, x, command, grantID); err != nil {
			return err
		}
		if grantID != "" {
			return s.priorDutyWithin(ctx, tx, a, x, grantID)
		}
		return nil
	case "job-cancel", "job-retry", "search-retry":
		service, err := s.jobActions(a)
		if err != nil {
			return err
		}
		return service.QualifyWithin(ctx, tx, a, kind, x, command)
	case "feedback-update":
		service, err := s.feedback(a)
		if err != nil {
			return err
		}
		if _, err = service.HeadWithin(ctx, tx, targetID); err != nil {
			return err
		}
	case "message-draft-create", "message-draft-save", "messaging-state":
		service, err := s.messages(a)
		if err != nil {
			return err
		}
		method := kind
		if kind == "messaging-state" {
			method = str(x["action"])
		}
		if err = service.QualifyDutyPreparedWithin(ctx, tx, a, targetID, method, command); err != nil {
			return err
		}
	case "account-restriction":
		service, err := s.accounts(a)
		if err != nil {
			return err
		}
		if _, err = service.AccountWithin(ctx, tx, targetID, false); err != nil {
			return err
		}
	case "private-case-message":
		service, err := s.chatReports(a)
		if err != nil {
			return err
		}
		var grant *string
		if grantID != "" {
			grant = &grantID
		}
		return service.QualifyActionMessageWithin(ctx, tx, a, targetID, str(x["messageId"]), num(command["messageRevision"]), grant)
	case "section-classification", "section-visibility":
		service, e := s.content(a)
		if e != nil {
			return e
		}
		if e = service.QualifyActionSectionWithin(ctx, tx, a, targetID); e != nil {
			return e
		}
	case "resource-visibility":
		service, e := s.resources(a)
		if e != nil {
			return e
		}
		if e = service.QualifyActionResourceWithin(ctx, tx, str(x["targetKind"]), targetID); e != nil {
			return e
		}
	case "case-resolve":
		service, e := s.content(a)
		if e != nil {
			return e
		}
		if e = service.QualifyActionCaseWithin(ctx, tx, a, targetID); e != nil {
			return e
		}
	case "content-visibility", "content-curation", "public-content-batch":
		if s.Content == nil || s.Content.Forum == nil {
			return fail("operations_agentos_action_not_connected", 503)
		}
		selected := []any{Object{"kind": x["targetKind"], "id": x["targetId"]}}
		if kind == "public-content-batch" {
			selected = items(x["items"])
			found := false
			for _, v := range selected {
				found = found || obj(v)["id"] == targetID
			}
			if !found {
				return fail("operations_agentos_scope_denied", 403)
			}
		}
		for _, v := range selected {
			r := obj(v)
			source, e := s.Content.Forum.OperationsContentSourceWithin(ctx, tx, str(r["kind"]), str(r["id"]), false)
			if e != nil {
				return e
			}
			if source["candidate"] != true || source["available"] != true {
				return fail("operations_source_unavailable", 409)
			}
			if grantID != "" && kind == "public-content-batch" {
				if e = s.priorDutyWithin(ctx, tx, a, Object{"kind": "content-visibility", "targetId": r["id"]}, grantID); e != nil {
					return e
				}
			}
		}
	case "file-access", "file-scan-retry":
		if s.Files == nil {
			return fail("operations_agentos_action_not_connected", 503)
		}
		if _, e = s.Files.ScopeActionFileWithin(ctx, tx, str(x["targetKind"]), str(x["targetId"])); e != nil {
			return e
		}
	default:
		return fail("operations_agentos_action_not_connected", 503)
	}
	if grantID != "" {
		return s.priorDutyWithin(ctx, tx, a, x, grantID)
	}
	return nil
}
func (s *Service) batchImpactWithin(ctx context.Context, tx pgx.Tx, a Actor, request, binding Object) error {
	operation := obj(binding["operation"])
	var task, version Object
	var kind string
	var ids []string
	if e := tx.QueryRow(ctx, `SELECT configuration FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, binding["taskId"]).Scan(&task); e != nil {
		return e
	}
	if e := tx.QueryRow(ctx, `SELECT resource_scope_kind,resource_ids::text[] FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, operation["grantId"]).Scan(&kind, &ids); e != nil {
		return e
	}
	if e := tx.QueryRow(ctx, `SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, operation["strategyVersionId"]).Scan(&version); e != nil {
		return e
	}
	var scope Object
	for _, v := range items(version["strategies"]) {
		r := obj(v)
		if r["id"] == operation["strategyId"] {
			scope = obj(obj(r["execution"])["resourceScope"])
			break
		}
	}
	plan := items(obj(task["plan"])["resourceIds"])
	if len(plan) == 0 || kind != "selected" || scope["kind"] != "selected" {
		return fail("operations_agentos_human_review_required", 409)
	}
	for _, v := range items(request["items"]) {
		id := obj(v)["id"]
		if !slices.Contains(plan, id) || !slices.Contains(ids, str(id)) || !slices.Contains(items(scope["resourceIds"]), id) {
			return fail("operations_agentos_human_review_required", 409)
		}
	}
	return nil
}
func (s *Service) DutyReceipt(ctx context.Context, a Actor, stored Object) (Object, error) {
	proposal := obj(stored["proposal"])
	op := str(stored["operation_id"])
	result, e := s.RecoverPrepared(ctx, a, proposal, op)
	if e != nil {
		return nil, e
	}
	state := "unknown"
	if result["state"] == "completed" {
		state = "completed"
	} else if result["state"] == "failed" {
		state = "failed"
	}
	out := clone(result)
	out["operationId"], out["effectState"], out["target"], out["basis"] = op, state, proposal["target"], "original-operation-query"
	if state == "completed" {
		out["basis"] = "persisted-domain-operation-receipt"
	}
	_, e = s.Pool.Exec(ctx, `UPDATE operations_ai_duty_operations_v1 SET state=$3,result=$4,updated_at=$5 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, op, state, out, time.Unix(s.now(), 0))
	return out, e
}
func (s *Service) ExecuteDutyOperation(ctx context.Context, a Actor, operationID string, input Object, reconcile bool) (Object, error) {
	if !s.isDuty(a) || s.Autonomy == nil {
		return nil, fail("operations_ai_duty_operation_denied", 403)
	}
	if !validID(operationID) {
		return nil, invalid()
	}
	request, e := ParseRequest(input)
	if e != nil {
		return nil, e
	}
	permission := required(request)
	definition := operationsai.Definition(permission)
	if definition["autonomous"] != true || definition["humanOnly"] == true {
		return Object{"operationId": operationID, "state": "waiting-human", "effectState": "not-started", "code": "operations_agentos_human_review_required", "basis": "fixed-human-condition"}, nil
	}
	if !s.ActionReady(permission) {
		return Object{"operationId": operationID, "state": "waiting-human", "effectState": "not-started", "code": "operations_agentos_action_not_connected", "basis": "handler-not-connected"}, nil
	}
	metadata, e := s.Permissions.Duty.DutyMetadata(a)
	if e != nil {
		return nil, e
	}
	read := func() (Object, error) {
		var stored Object
		e := s.Pool.QueryRow(ctx, `SELECT to_jsonb(o) FROM operations_ai_duty_operations_v1 o WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID).Scan(&stored)
		if e == pgx.ErrNoRows {
			return nil, nil
		}
		return stored, e
	}
	prior, e := read()
	if e != nil {
		return nil, e
	}
	if prior != nil {
		if prior["task_id"] != metadata["taskId"] || prior["ai_account_id"] != metadata["aiAccountId"] || !same(prior["request"], request) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return s.DutyReceipt(ctx, a, prior)
	}
	if reconcile {
		return Object{"operationId": operationID, "state": "unknown", "effectState": "unknown", "code": "operations_agentos_original_operation_not_recorded", "basis": "original-operation-query"}, nil
	}
	proposal, e := s.Prepare(ctx, a, str(metadata["domain"]), request, operationID)
	if e != nil {
		return nil, e
	}
	target := str(obj(proposal["target"])["id"])
	bound, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
		return s.Autonomy.BindDutyOperationWithin(ctx, tx, a, operationsautonomy.DutyOperation{Permission: permission, TargetID: target, OperationID: operationID, Request: request, Command: obj(proposal["command"])})
	})
	if e != nil {
		return nil, e
	}
	binding, e := s.Permissions.Duty.DutyMetadata(bound)
	if e != nil {
		return nil, e
	}
	_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		if request["kind"] == "public-content-batch" {
			if e = s.batchImpactWithin(ctx, tx, bound, request, binding); e != nil {
				return false, e
			}
		}
		e = s.QualifyTargetWithin(ctx, tx, bound, permission, target, request, obj(proposal["command"]), str(obj(binding["operation"])["grantId"]))
		return e == nil, e
	})
	if e != nil {
		return nil, e
	}
	frozen := pick(proposal, "schemaVersion", "kind", "domain", "request", "command", "requiredAction")
	frozen["target"] = pick(obj(proposal["target"]), "kind", "id")
	frozen["decisionSource"] = "approved-automatic-plan"
	type storedResult struct {
		row      Object
		existing bool
	}
	stored, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (storedResult, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912487))`, s.Endpoint+":"+operationID); e != nil {
			return storedResult{}, e
		}
		var row Object
		e := tx.QueryRow(ctx, `SELECT to_jsonb(o) FROM operations_ai_duty_operations_v1 o WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID).Scan(&row)
		if e == nil {
			return storedResult{row, true}, nil
		}
		if e != pgx.ErrNoRows {
			return storedResult{}, e
		}
		e = tx.QueryRow(ctx, `INSERT INTO operations_ai_duty_operations_v1(operation_id,endpoint,task_id,ai_account_id,kind,request,proposal,binding,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'dispatching',$9,$9) RETURNING to_jsonb(operations_ai_duty_operations_v1)`, operationID, s.Endpoint, metadata["taskId"], metadata["aiAccountId"], request["kind"], request, frozen, binding, time.Unix(s.now(), 0)).Scan(&row)
		return storedResult{row, false}, e
	})
	if e != nil {
		return nil, e
	}
	if !same(stored.row["request"], request) || stored.row["task_id"] != metadata["taskId"] {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	if stored.existing {
		return s.DutyReceipt(ctx, a, stored.row)
	}
	if _, e = s.ExecutePrepared(ctx, bound, proposal, operationID, func(context.Context, pgx.Tx) (Actor, error) { return bound, nil }); e == nil {
		return s.DutyReceipt(ctx, a, stored.row)
	}
	_, persist := s.Pool.Exec(ctx, `UPDATE operations_ai_duty_operations_v1 SET state='unknown',updated_at=$3 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID, time.Unix(s.now(), 0))
	if persist != nil {
		return nil, persist
	}
	if fault.Code(e) == "operations_agentos_human_review_required" {
		return Object{"operationId": operationID, "state": "waiting-human", "effectState": "unknown", "code": fault.Code(e), "basis": "current-human-condition"}, nil
	}
	return nil, e
}
func (s *Service) PersistedSourceWithin(ctx context.Context, tx pgx.Tx, metadata Object) (bool, error) {
	operation := obj(metadata["operation"])
	if metadata["contextSchemaVersion"] == nil || num(metadata["contextSchemaVersion"]) != 1 || metadata["endpoint"] != s.Endpoint || metadata["accessPurpose"] != "execution" || !validID(operation["operationId"]) {
		return false, nil
	}
	var task, account string
	var binding, proposal Object
	e := tx.QueryRow(ctx, `SELECT task_id::text,ai_account_id::text,binding,proposal FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operation["operationId"]).Scan(&task, &account, &binding, &proposal)
	if e == pgx.ErrNoRows {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	return task == metadata["taskId"] && account == metadata["aiAccountId"] && same(binding, metadata) && proposal["requiredAction"] == operation["permission"] && obj(proposal["target"])["id"] == operation["targetId"] && same(proposal["request"], operation["request"]) && same(proposal["command"], operation["command"]), nil
}
