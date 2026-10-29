package agentos

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestConversationProjectionTimesBoundRetryPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	f.Delegated(t)
	ctx := context.Background()
	s := &Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Now: f.Now}
	current, err := s.Session(ctx, f.Root, "overview", true)
	if err != nil {
		t.Fatal(err)
	}
	parent, child := uuid.NewString(), uuid.NewString()
	pRun, cRun := uuid.NewString(), uuid.NewString()
	first := time.Unix(1000, 0).UTC()
	insert := func(id, run string, result Object, at time.Time) {
		t.Helper()
		if _, e := owner.Exec(ctx, `INSERT INTO operations_agentos_conversation_commands_v1(id,endpoint,conversation_id,operator_id,message_digest,state,result,native_run_id,created_at) VALUES($1,$2,$3,$4,$5,'accepted',$6,$7,$8)`, id, f.Endpoint, current.Row.ID, f.Root.ID, strings.Repeat("d", 64), result, run, at); e != nil {
			t.Fatal(e)
		}
	}
	insert(parent, pRun, Object{}, first)
	insert(child, cRun, Object{"retryOfOperationId": parent, "retryOfRunId": pRun}, first.Add(25*time.Second))
	runs := []Object{{"operationId": parent, "runId": pRun, "status": "ERROR", "createdAt": 500, "completedAt": 1040}, {"operationId": child, "runId": cRun, "status": "COMPLETED", "createdAt": 1025, "completedAt": 1050}, {"operationId": child, "runId": uuid.NewString(), "status": "COMPLETED", "createdAt": 1025, "completedAt": 1060}, {"runId": "legacy", "status": "COMPLETED", "createdAt": 100, "completedAt": nil}}
	if err = s.projectConversationTimes(ctx, *current.Row, runs, []string{parent, child}); err != nil {
		t.Fatal(err)
	}
	if runs[0]["sentAt"] != int64(1000) || runs[0]["completedAt"] != nil || runs[1]["sentAt"] != int64(1000) || runs[1]["completedAt"] != int64(1050) || runs[2]["sentAt"] != nil || runs[2]["completedAt"] != nil || runs[3]["sentAt"] != int64(100) || runs[3]["completedAt"] != nil {
		t.Fatalf("unexpected time projection %#v", runs)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_agentos_conversation_commands_v1 SET result=jsonb_set(result,'{retryOfRunId}',to_jsonb($2::text)) WHERE id=$1`, child, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if err = s.projectConversationTimes(ctx, *current.Row, runs, []string{child}); err != nil {
		t.Fatal(err)
	}
	if runs[1]["sentAt"] != nil {
		t.Fatal("broken retry proof supplied sentAt")
	}
}
