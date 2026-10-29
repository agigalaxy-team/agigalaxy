package operationspermissions_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	perms "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOriginalDelegationActionAndQueryConsumers(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	currentFixture := operationsfixture.New(t, owner)
	base := currentFixture.Data
	currentFixture.Automation(t)
	fixture := currentFixture.Delegated(t)
	ids := object(base["ids"])
	endpoint, issuer := text(base["endpoint"]), text(base["issuer"])
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: text(ids["root"]), Issuer: issuer, Subject: "root"}}, &directory{denied: map[string]bool{}})
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	service := &perms.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	authenticate := func(context.Context) (perms.Actor, error) {
		req, _ := http.NewRequest("POST", "https://admin.example.invalid/v1/operations/agentos/conversations/confirm", nil)
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
		return gateway.AuthorizeOperations(req, true, "workbench.read")
	}
	human, e := authenticate(ctx)
	if e != nil {
		t.Fatal(e)
	}
	input := map[string]any{"kind": "ai-role-command", "command": map[string]any{"kind": "role-create", "expectedVersion": 0, "name": "Go operation-card role", "description": "Original prepare consumer", "enabled": true, "permissions": []string{"feedback.read"}, "targetAiAccountIds": []string{text(object(fixture["governance"])["id"])}}}
	op := uuid.NewString()
	proposal, e := service.PrepareManagementAction(ctx, human, "overview", input, op)
	if e != nil {
		t.Fatal(e)
	}
	source := currentFixture.PrepareAction(t, map[string]any{"request": input, "operationId": op})
	if !equal(proposal, source) {
		t.Fatalf("prepare differs\nGo%s\nJS%s", jsonText(proposal), jsonText(source))
	}
	missing, e := service.RecoverManagementAction(ctx, human, proposal, op)
	if e != nil || missing["state"] != "not-recorded" {
		t.Fatalf("missing original %v", e)
	}
	originalMissing := currentFixture.RecoverAction(t, map[string]any{"proposal": proposal, "operationId": op})
	if !equal(missing, originalMissing) {
		t.Fatal("missing result differs")
	}
	result, e := service.ExecuteManagementAction(ctx, human, proposal, op, authenticate)
	if e != nil || result["state"] != "completed" {
		t.Fatalf("Go original execute %v", e)
	}
	source = currentFixture.RecoverAction(t, map[string]any{"proposal": proposal, "operationId": op})
	recovered, e := service.RecoverManagementAction(ctx, human, proposal, op)
	if e != nil || !equal(source, recovered) {
		t.Fatalf("Go effect→JS/Go recover %v", e)
	}
	input2 := clone(input)
	object(input2["command"])["name"] = "Original JS card role"
	op2 := uuid.NewString()
	proposal2, e := service.PrepareManagementAction(ctx, human, "overview", input2, op2)
	if e != nil {
		t.Fatal(e)
	}
	source = currentFixture.ExecuteAction(t, map[string]any{"proposal": proposal2, "operationId": op2})
	recovered, e = service.RecoverManagementAction(ctx, human, proposal2, op2)
	if e != nil || object(recovered["receipt"])["replayed"] != true || object(source["receipt"])["roleId"] != object(recovered["receipt"])["roleId"] {
		t.Fatalf("JS execute→Go recovery %v", e)
	}
	unknownInput := clone(input)
	object(unknownInput["command"])["name"] = "Committed before authorization outage"
	op3 := uuid.NewString()
	proposal3, e := service.PrepareManagementAction(ctx, human, "overview", unknownInput, op3)
	if e != nil {
		t.Fatal(e)
	}
	calls := 0
	unknown, e := service.ExecuteManagementAction(ctx, human, proposal3, op3, func(ctx context.Context) (perms.Actor, error) {
		calls++
		if calls == 2 {
			return perms.Actor{}, fault.New("operations_unavailable", 503)
		}
		return authenticate(ctx)
	})
	if e != nil || unknown["state"] != "unknown" || unknown["receipt"] != nil {
		t.Fatalf("committed command lost unknown state %v", e)
	}
	var before, after int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM operations_ai_role_delegation_events_v1 WHERE endpoint=$1", endpoint).Scan(&before); e != nil {
		t.Fatal(e)
	}
	recovered, e = service.RecoverManagementAction(ctx, human, proposal3, op3)
	if e != nil || recovered["state"] != "completed" {
		t.Fatalf("unknown not recovered %v", e)
	}
	owner.QueryRow(ctx, "SELECT count(*) FROM operations_ai_role_delegation_events_v1 WHERE endpoint=$1", endpoint).Scan(&after)
	if before != after {
		t.Fatal("recovery resubmitted the original write")
	}
	target := object(fixture["governance"])["id"]
	promptInput := map[string]any{"kind": "ai-work-prompt-save", "aiAccountId": target, "prompt": "Consumer saved role requirements"}
	promptOp := uuid.NewString()
	promptProposal, e := service.PrepareManagementAction(ctx, human, "overview", promptInput, promptOp)
	if e != nil {
		t.Fatal(e)
	}
	source = currentFixture.PrepareAction(t, map[string]any{"request": promptInput, "operationId": promptOp})
	if !equal(promptProposal, source) {
		t.Fatal("prompt review card differs")
	}
	if _, e = service.ExecuteManagementAction(ctx, human, promptProposal, promptOp, authenticate); e != nil {
		t.Fatal(e)
	}
	source = currentFixture.RecoverAction(t, map[string]any{"proposal": promptProposal, "operationId": promptOp})
	recovered, e = service.RecoverManagementAction(ctx, human, promptProposal, promptOp)
	if e != nil || !equal(recovered, source) {
		t.Fatalf("prompt consumer original receipt %v", e)
	}
	for _, arguments := range []map[string]any{{}, {"aiAccountId": target}} {
		got, e := service.ReadManagementTool(ctx, human, "overview", arguments)
		if e != nil {
			t.Fatal(e)
		}
		want := currentFixture.ReadManagement(t, map[string]any{"arguments": arguments})
		if !equal(got, want) {
			t.Fatalf("read-ai-delegation projection differs\nGo%s\nJS%s", jsonText(got), jsonText(want))
		}
	}
	tampered := clone(proposal)
	object(object(tampered["command"])["command"])["name"] = "Changed approved command"
	if _, e = service.ExecuteManagementAction(ctx, human, tampered, op, authenticate); fault.Code(e) != "invalid_operations_agentos_action" {
		t.Fatalf("changed card executed %v", e)
	}
	t.Log("original prepare/execute/recover/read-tool consumers match; post-commit authorization outage remains unknown and recovery never resubmits")
}
