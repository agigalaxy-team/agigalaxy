package operationsautonomy

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

const prepareCommunityParameterTool = "prepare-community-parameters"
const readCommunityParameterTool = "read-community-parameters"
const communityParameterAdjustment = "community-parameter-adjustment"

func communityParametersAllowed(task Object) bool {
	if task["domain"] != "governance" || task["source"] == "workbench" {
		return false
	}
	plan := obj(obj(task["configuration"])["plan"])
	return plan["communityParameterProposals"] == true &&
		obj(plan["resourceScope"])["kind"] != "selected" && len(texts(plan["resourceIds"])) == 0
}

func communityParameterPermission(area string, write bool) string {
	if area == "growth" {
		if write {
			return "rules.write"
		}
		return "rules.read"
	}
	if area == "content-score" || area == "recommendation" {
		if write {
			return "recommendations.configure"
		}
		return "recommendations.read"
	}
	return ""
}

func macroProposal(call Object) Object {
	if call["tool"] != prepareCommunityParameterTool {
		return nil
	}
	return obj(obj(call["read_outcome"])["communityParameterProposal"])
}

func macroProposalView(proposal Object, actor Actor) Object {
	request := obj(proposal["request"])
	area := str(request["area"])
	read := communityParameterPermission(area, false)
	if proposal["kind"] != communityParameterAdjustment || read == "" || !has(actor.Permissions, read) {
		return nil
	}
	return Object{
		"kind": proposal["kind"], "area": area, "scope": request["scope"], "title": proposal["title"],
		"target": proposal["target"], "changes": proposal["changes"], "basis": proposal["basis"], "impact": proposal["impact"],
		"canApprove": has(actor.Permissions, "autonomy.control") && has(actor.Permissions, communityParameterPermission(area, true)),
	}
}

func (s *Service) existingMacroProposalWithin(ctx context.Context, tx pgx.Tx, proposal Object, operationID string) (Object, error) {
	request := obj(proposal["request"])
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912764))`,
		s.Endpoint+":"+str(request["area"])+":"+str(request["scope"])); err != nil {
		return nil, err
	}
	return optional(ctx, tx, `SELECT jsonb_build_object('taskId',c.task_id,'callId',c.call_id,'operationId',c.operation_id)
		FROM operations_autonomy_tool_calls_v1 c
		JOIN operations_autonomy_tasks_v1 t ON t.endpoint=c.endpoint AND t.id=c.task_id
		LEFT JOIN operations_autonomy_decisions_v1 d ON d.endpoint=c.endpoint AND d.task_id=c.task_id AND d.call_id=c.call_id
		WHERE c.endpoint=$1 AND c.tool=$2 AND c.state='waiting-human' AND t.state='waiting-human'
		AND c.operation_id<>$3 AND d.call_id IS NULL
		AND c.read_outcome#>>'{communityParameterProposal,request,area}'=$4
		AND c.read_outcome#>>'{communityParameterProposal,request,scope}'=$5
		AND c.read_outcome#>'{communityParameterProposal,request,expectedVersion}'=$6::jsonb
		ORDER BY c.created_at,c.call_id LIMIT 1`, s.Endpoint, prepareCommunityParameterTool, operationID,
		request["area"], request["scope"], jsonText(request["expectedVersion"]))
}

func (s *Service) confirmMacroDecisionWithin(ctx context.Context, tx pgx.Tx, actor Actor, task, call Object) (Object, error) {
	proposal := macroProposal(call)
	if proposal == nil || s.ConfirmCommunityParametersWithin == nil {
		return nil, fail("operations_autonomy_decision_not_pending")
	}
	area := str(obj(proposal["request"])["area"])
	read := communityParameterPermission(area, false)
	if read == "" || !has(actor.Permissions, read) {
		return nil, fault.New("operations_permission_denied", 403)
	}
	operationID := str(call["operation_id"])
	result, err := s.ConfirmCommunityParametersWithin(ctx, tx, actor, proposal, operationID)
	if err != nil {
		return nil, err
	}
	if result["state"] != "completed" || result["operationId"] != operationID {
		return nil, fail("operations_autonomy_operation_conflict")
	}
	if err = s.RecordBusinessReceiptWithin(ctx, tx, BusinessReceipt{
		TaskID: str(task["id"]), OperationID: operationID, Action: communityParameterAdjustment,
		State: "completed", Basis: "persisted-domain-operation-receipt",
	}); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE operations_autonomy_tool_calls_v1 SET read_outcome=read_outcome||jsonb_build_object('communityParameterReceipt',$4::jsonb)
		WHERE endpoint=$1 AND task_id=$2 AND call_id=$3`, s.Endpoint, task["id"], call["call_id"], jsonText(result["receipt"])); err != nil {
		return nil, err
	}
	return obj(result["receipt"]), nil
}
