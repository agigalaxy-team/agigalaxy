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

func TestHumanAIWorkDelegatedRoleAndPromptOriginalPath(t *testing.T) {
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
	req, _ := http.NewRequest("GET", "https://admin.example.invalid/v1/operations/session", nil)
	req.Header.Set("Origin", "https://admin.example.invalid")
	req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	human, e := gateway.AuthorizeOperations(req, false, "workbench.read")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = service.DelegatedDirectory(ctx, human); fault.Code(e) != "business_admin_denied" {
		t.Fatalf("plain human impersonated an AI work context: %v", e)
	}
	bind := func(purpose string) perms.Actor {
		t.Helper()
		tx, e := pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		a, e := service.HumanAIWithin(ctx, tx, human, "overview", purpose, "workbench.read")
		if e != nil {
			tx.Rollback(ctx)
			t.Fatal(e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		return a
	}
	actor := bind("query")
	source := currentFixture.DelegatedRead(t, nil)
	if !equal(map[string]any{"version": actor.Version, "permissions": actor.Permissions}, source["actor"]) {
		t.Fatalf("human/AI version or intersection differs Go%s JS%s", jsonText(actor), jsonText(source["actor"]))
	}
	directory, e := service.DelegatedDirectory(ctx, actor)
	if e != nil {
		t.Fatal(e)
	}
	if !equal(directory, source["directory"]) {
		t.Fatalf("delegated directory differs Go%s JS%s", jsonText(directory), jsonText(source["directory"]))
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	capabilities, e := service.ManagementCapabilitiesWithin(ctx, tx, actor)
	tx.Rollback(ctx)
	if e != nil || !equal(capabilities, source["capabilities"]) {
		t.Fatalf("capabilities differ %v\nGo%s\nJS%s", e, jsonText(capabilities), jsonText(source["capabilities"]))
	}
	expected := int64(1)
	retry, e := service.DelegatedRoleSave(ctx, actor, object(fixture["originalInput"]), perms.DelegatedOptions{ExpectedDelegationVersion: &expected})
	if e != nil || retry["replayed"] != true {
		t.Fatalf("original role replay %v", e)
	}
	target := object(fixture["governance"])["id"]
	input := map[string]any{"kind": "role-create", "operationId": uuid.NewString(), "expectedVersion": 0, "name": "Go delegated role", "description": "Only target AI", "enabled": true, "permissions": []string{"feedback.read"}, "targetAiAccountIds": []string{text(target)}}
	prepare := clone(input)
	delete(prepare, "operationId")
	prepared, e := service.DelegatedRolePreparation(ctx, actor, prepare)
	if e != nil {
		t.Fatal(e)
	}
	source = currentFixture.DelegatedRead(t, map[string]any{"prepare": prepare})
	if !equal(prepared, source["preparation"]) {
		t.Fatal("preparation differs")
	}
	saved, e := service.DelegatedRoleSave(ctx, actor, input, perms.DelegatedOptions{ExpectedDelegationVersion: &expected})
	if e != nil {
		t.Fatal(e)
	}
	role := object(saved["role"])
	if role["subjectScope"] != "ai-only" {
		t.Fatal("delegated role not AI-only")
	}
	source = currentFixture.DelegatedRead(t, map[string]any{"operationId": input["operationId"]})
	receipt, e := service.DelegatedManagementOperation(ctx, actor, text(input["operationId"]), nil, nil)
	if e != nil || !equal(receipt, source["operation"]) {
		t.Fatalf("delegated receipt %v", e)
	}
	assignment := map[string]any{"kind": "assignment-save", "operationId": uuid.NewString(), "expectedVersion": 0, "aiAccountId": target, "roleId": role["id"], "enabled": true}
	if _, e = service.DelegatedRoleSave(ctx, actor, assignment, perms.DelegatedOptions{}); e != nil {
		t.Fatal(e)
	}
	update := clone(input)
	update["kind"], update["id"], update["operationId"], update["expectedVersion"], update["permissions"] = "role-update", role["id"], uuid.NewString(), 1, []string{"feedback.read", "feedback.update"}
	if _, e = service.DelegatedRoleSave(ctx, actor, update, perms.DelegatedOptions{}); e != nil {
		t.Fatal(e)
	}
	bad := clone(input)
	bad["operationId"], bad["targetAiAccountIds"] = uuid.NewString(), []string{text(object(fixture["overview"])["id"])}
	if _, e = service.DelegatedRoleSave(ctx, actor, bad, perms.DelegatedOptions{}); fault.Code(e) != "operations_ai_delegation_ceiling_denied" {
		t.Fatalf("self target allowed %v", e)
	}
	bad = clone(update)
	bad["operationId"], bad["id"], bad["expectedVersion"] = uuid.NewString(), object(base["writerRole"])["id"], 1
	if _, e = service.DelegatedRoleSave(ctx, actor, bad, perms.DelegatedOptions{}); fault.Code(e) != "operations_ai_delegation_role_denied" {
		t.Fatalf("human shared role modified %v", e)
	}
	prompt, e := service.DelegatedPrompt(ctx, actor, map[string]any{"aiAccountId": target})
	if e != nil {
		t.Fatal(e)
	}
	source = currentFixture.DelegatedRead(t, map[string]any{"aiAccountId": target})
	if !equal(prompt, source["prompt"]) {
		t.Fatal("prompt read differs")
	}
	promptInput := map[string]any{"operationId": uuid.NewString(), "aiAccountId": target, "expectedRevision": 1, "expectedPromptVersion": 1, "prompt": "New synthetic role-work requirements"}
	if _, e = service.DelegatedPromptSave(ctx, actor, promptInput, perms.DelegatedOptions{}); e != nil {
		t.Fatal(e)
	}
	var config map[string]any
	if e = owner.QueryRow(ctx, "SELECT configuration FROM operations_autonomy_configs_v1 WHERE id=$1", fixture["configId"]).Scan(&config); e != nil {
		t.Fatal(e)
	}
	original := object(fixture["configuration"])
	if !equal(config["model"], original["model"]) || !equal(config["plan"], original["plan"]) {
		t.Fatal("prompt save overwrote other configuration")
	}
	source = currentFixture.DelegatedRead(t, map[string]any{"aiAccountId": target, "operationId": promptInput["operationId"]})
	prompt, e = service.DelegatedPrompt(ctx, actor, map[string]any{"aiAccountId": target})
	if e != nil || !equal(prompt, source["prompt"]) {
		t.Fatal("Go prompt save differs from original JS read")
	}
	if _, e = owner.Exec(ctx, "UPDATE operations_ai_role_delegations_v1 SET enabled=false WHERE endpoint=$1", endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = service.DelegatedManagementOperation(ctx, actor, text(input["operationId"]), nil, nil); fault.Code(e) != "operations_ai_delegation_denied" {
		t.Fatalf("revoked delegation disclosed old operation %v", e)
	}
	t.Log("real management session→purpose-bound human/AI intersection→delegated AI-only role/assignment/prompt→original JS receipts and revocation passed")
}
