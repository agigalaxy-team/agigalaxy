package agentos_test

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestSummaryUsesOwnerVerifiedOriginalRehearsalPG(t *testing.T) {
	ctx := context.Background()
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	role, err := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Rehearsal reviewer", "description": "Reviewed source", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"strategies.read", "strategies.configure"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Permissions.AIWorkAssignment(ctx, f.Root, "overview", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	strategies := &operationsstrategies.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	draft, err := strategies.SaveDraft(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedRevision": 0, "configuration": operationsstrategies.EmptyConfiguration(), "reason": "Reviewed draft"}, func() (p.Actor, error) { return f.Root, nil })
	if err != nil {
		t.Fatal(err)
	}
	operation, priorTurn, turn, toolID, cardID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Strategies: strategies, Now: f.Now}
	proposal, err := service.Prepare(ctx, f.Root, "overview", map[string]any{"kind": "strategy-rehearsal", "versionId": draft["versionId"], "executionIds": []any{}}, operation)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := strategies.Rehearsal(ctx, f.Root, map[string]any{"operationId": operation, "versionId": draft["versionId"], "executionIds": []any{}})
	if err != nil || receipt["valid"] != true {
		t.Fatalf("original rehearsal: %#v %v", receipt, err)
	}
	conversations := &agentos.Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := conversations.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		id string
		at time.Time
	}{{priorTurn, f.Now().Add(-time.Minute)}, {turn, f.Now()}} {
		if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,created_at) VALUES($1,$2,$3,$4,'digest','accepted','{}',$5)`, item.id, f.Endpoint, current.Row.ID, f.Root.ID, item.at); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_tool_calls_v1(id,endpoint,conversation_id,turn_id,native_run_id,call_id,tool,arguments_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'native','call','prepare-operation','digest','completed',$5,$5)`, toolID, f.Endpoint, current.Row.ID, priorTurn, f.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	result := map[string]any{"operationId": operation, "state": "completed", "summary": "Original rehearsal", "receipt": receipt}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_cards_v1(id,endpoint,conversation_id,turn_id,tool_call_id,operator_id,domain,operation_id,request_digest,proposal,state,result,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'overview',$7,'digest',$8,'completed',$9,$10,$10)`, cardID, f.Endpoint, current.Row.ID, priorTurn, toolID, f.Root.ID, operation, proposal, result, f.Now().Add(-time.Second)); err != nil {
		t.Fatal(err)
	}
	tools := &agentos.ConversationTools{Conversations: conversations, RecoverPrepared: service.RecoverPrepared, CardReadPermission: func(string) (string, error) { return "strategies.read", nil }}
	read := func() map[string]any {
		value, e := tools.SummaryContext(ctx, f.Root, "overview", map[string]any{"conversationId": current.Row.ID, "turnId": turn}, agentos.SummaryContextReaders{})
		if e != nil {
			t.Fatal(e)
		}
		return value
	}
	resultSummary := read()
	prior := resultSummary["priorOperationReceipts"].(map[string]any)
	items := prior["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("missing original summary: %#v", prior)
	}
	entry := items[0].(map[string]any)
	effect := entry["recordedEffect"].(map[string]any)
	if effect["rehearsalId"] != operation || effect["versionId"] != draft["versionId"] || effect["valid"] != true || effect["basis"] != "historical-original-rehearsal-not-current-publish-authorization" || entry["effectExecuted"] != false {
		t.Fatalf("wrong original facts: %#v", entry)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_rehearsals_v1 SET result=jsonb_set(result,'{valid}','"not-a-boolean"'::jsonb) WHERE endpoint=$1 AND id=$2`, f.Endpoint, operation); err != nil {
		t.Fatal(err)
	}
	invalid := read()["priorOperationReceipts"].(map[string]any)
	if invalid["availability"] != "partial" || len(invalid["items"].([]any)) != 0 {
		t.Fatalf("nonboolean result treated as valid: %#v", invalid)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_p13_strategy_rehearsals_v1 SET result=jsonb_set(result,'{valid}','true'::jsonb) WHERE endpoint=$1 AND id=$2`, f.Endpoint, operation); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_cards_v1 SET proposal=jsonb_set(proposal,'{request,versionId}',to_jsonb($3::text)) WHERE endpoint=$1 AND id=$2`, f.Endpoint, cardID, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	invalid = read()["priorOperationReceipts"].(map[string]any)
	if invalid["availability"] != "partial" || len(invalid["items"].([]any)) != 0 {
		t.Fatalf("changed version disclosed an original result: %#v", invalid)
	}
}
