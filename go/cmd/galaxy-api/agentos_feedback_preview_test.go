package main

import (
	"context"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type noFeedbackPreviewRead struct{ p.Authority }

func (a noFeedbackPreviewRead) RequireWithin(ctx context.Context, tx pgx.Tx, actor p.Actor, action string) (p.Actor, error) {
	if action == "feedback.read" {
		return p.Actor{}, fault.New("operations_permission_denied", 403)
	}
	return a.Authority.RequireWithin(ctx, tx, actor, action)
}

func TestFeedbackStrategyPreviewUsesProductionSourceAndCurrentAuthority(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.New(t, owner)
	automation := f.Automation(t)
	ai := automation["accounts"].(map[string]any)["governance"].(string)
	account, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (accounts.Account, error) {
		return (&accounts.Service{Endpoint: f.Endpoint, Now: f.Now}).EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: "https://synthetic.invalid", ExternalSubject: uuid.NewString(), VerificationMethod: "external-account", VerifiedAt: f.Now()})
	})
	if err != nil {
		t.Fatal(err)
	}
	id, grant, strategyID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO operations_feedback_v1(id,endpoint,account_id,submission_operation_id,request_hash,title,body,submitted_module,module,state,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'Synthetic feedback','Synthetic body','other','other','pending',1,$6,$6)`, id, f.Endpoint, account.ID, uuid.NewString(), strings.Repeat("a", 64), f.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,ai_account_id,resource_scope_kind) VALUES($1,$2,'Synthetic grant','ai','automatic',true,1,ARRAY['feedback.update'],$3,$4,$4,$5,$5,$6,'selected')`, grant, f.Endpoint, []string{id}, f.Root.ID, f.Now(), ai); err != nil {
		t.Fatal(err)
	}
	duty := &operationsautonomy.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, AIWork: f.Permissions.AIWork, Now: f.Now}
	feedbackOwner := &feedback.Operations{Service: &feedback.Service{Pool: f.Pool, Endpoint: f.Endpoint, Now: f.Now}, Domain: &businessadmin.Domain{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, PrincipalWithin: f.Gateway.LockOperationsPrincipalWithin, Now: f.Now}}
	conversations := &agentos.Conversations{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Tools: &agentos.ConversationTools{}}
	actions := connectWorkbenchActions(conversations, duty, nil, nil)
	actions.Feedback = feedbackOwner
	content := &operationscommunity.Service{Pool: f.Pool, Endpoint: f.Endpoint}
	_, strategy := connectExecutions(f.Gateway, f.Permissions, duty, content, nil, feedbackOwner, nil, nil)
	if !strategy.ActionReady("feedback.update", "ai") || strategy.ActionReady("feedback.update", "code") {
		t.Fatal("registry readiness or code boundary wrong")
	}
	configuration := map[string]any{"common": map[string]any{"objective": "Synthetic goal"}, "domains": []any{map[string]any{"key": "governance", "objective": "Synthetic goal"}}, "strategies": []any{map[string]any{"id": strategyID, "domain": "governance", "objective": "Synthetic goal", "judgment": "prepared-command", "execution": map[string]any{"aiDomain": "governance", "mode": "ai", "trigger": map[string]any{"kind": "manual"}, "grantIds": []any{grant}, "actions": []any{"feedback.update"}, "resourceScope": map[string]any{"kind": "selected", "resourceIds": []any{id}}, "requiredRehearsal": true}}}}
	preview := func() (map[string]any, error) {
		return postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (map[string]any, error) {
			return strategy.PreviewWithin(ctx, tx, configuration, strategyID, f.Root)
		})
	}
	result, err := preview()
	if err != nil || result["valid"] != true {
		t.Fatalf("valid preview %#v %v", result, err)
	}
	objects := result["objects"].([]any)
	source := objects[0].(map[string]any)
	if source["available"] != true || source["version"] != float64(1) && source["version"] != 1 {
		t.Fatalf("original feedback revision %#v", source)
	}
	strategy.Authority = noFeedbackPreviewRead{Authority: f.Gateway}
	result, err = preview()
	if err != nil || result["valid"] != false || len(result["objects"].([]any)) != 0 {
		t.Fatalf("revoked source read %#v %v", result, err)
	}
	strategy.Authority = &p.BusinessAuthority{Human: f.Gateway, Duty: duty}
	deleteID := uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO account_feedback_data_operations_v1(operation_id,endpoint,account_id,kind,cutoff_sequence,state,feedback_count,attachment_count,metadata_deleted,created_at,updated_at) VALUES($1,$2,$3,'delete',0,'completed',1,0,true,$4,$4)`, deleteID, f.Endpoint, account.ID, f.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `UPDATE operations_feedback_v1 SET owner_deleted_at=$2,owner_delete_operation_id=$3,title=NULL,body=NULL WHERE id=$1`, id, f.Now(), deleteID); err != nil {
		t.Fatal(err)
	}
	result, err = preview()
	if err != nil || result["valid"] != false {
		t.Fatalf("deleted source preview %#v %v", result, err)
	}
	objects = result["objects"].([]any)
	if len(objects) != 1 || objects[0].(map[string]any)["available"] != false {
		t.Fatalf("deleted source available %#v", objects)
	}
}
