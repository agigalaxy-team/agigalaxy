package actions_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type cardDirectory struct{}

func (cardDirectory) Roles(context.Context, string, string) ([]string, error) {
	return []string{"admit-admin"}, nil
}
func (d cardDirectory) RolesFresh(ctx context.Context, i, s string) ([]string, error) {
	return d.Roles(ctx, i, s)
}

// This is one owning consumer path, not a duplicate P14/schema regression suite.
// The single API-role connection also makes an accidental nested pool lease in
// the write-time authorize callback fail rather than masking it with spare PGs.
func TestPreparedRulePublicationUsesCurrentTransactionAndOriginalReceipt(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, e := filepath.Abs("../../../..")
	if e != nil {
		t.Fatal(e)
	}
	fixture := func(mode string) map[string]any {
		t.Helper()
		command := exec.Command("node", filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), mode)
		command.Dir = root
		command.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		command.Stdin = bytes.NewBufferString("{}")
		raw, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("original fixture %s: %v %s", mode, err, raw)
		}
		var out map[string]any
		if err = json.Unmarshal(raw, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	base := fixture("setup")
	fixture("automation-setup")
	endpoint, issuer := base["endpoint"].(string), base["issuer"].(string)
	rootID := base["ids"].(map[string]any)["root"].(string)
	config, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	config.MaxConns = 1
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, err := c.Exec(ctx, "SET ROLE galaxy_api"); return err }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: rootID, Issuer: issuer, Subject: "root"}}, cardDirectory{})
	if e != nil {
		t.Fatal(e)
	}
	now := func() time.Time { return time.Unix(2000000000, 0) }
	gateway.Now = now
	request, _ := http.NewRequest("POST", "https://admin.example.invalid/v1/operations/agentos/conversations/confirm", nil)
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	human, e := gateway.AuthorizeOperations(request, true, "workbench.read")
	if e != nil {
		t.Fatal(e)
	}
	permissions := &p.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now, AIWork: &operationsai.Service{Endpoint: endpoint}}
	role, e := permissions.SaveRole(ctx, human, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Isolated prepared rule reader and publisher", "description": "Original human-reviewed operation card", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"rules.read", "rules.write"}})
	if e != nil {
		t.Fatal(e)
	}
	_, e = permissions.AIWorkAssignment(ctx, human, "governance", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true})
	if e != nil {
		t.Fatal(e)
	}
	rules := &operationsrules.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now}
	budgetBytes, _ := json.Marshal(resourcebudget.DefaultPolicy())
	var budget map[string]any
	if e = json.Unmarshal(budgetBytes, &budget); e != nil {
		t.Fatal(e)
	}
	forum, e := community.LoadForumPolicy("")
	if e != nil {
		t.Fatal(e)
	}
	if e = rules.Bootstrap(ctx, map[string]map[string]any{"resource-budget": budget, "community-quota": publicwrites.DefaultPolicy(), "forum-quota": forum}); e != nil {
		t.Fatal(e)
	}
	if e = rules.Initialize(ctx); e != nil {
		t.Fatal(e)
	}
	policy := operationsrules.EmptyControls()
	policy["lists"] = []any{map[string]any{"id": uuid.NewString(), "name": "Saved isolated keyword list", "kind": "keyword", "enabled": true, "entries": []any{"isolated-keyword"}}}
	saved, e := rules.SaveDraft(ctx, human, "business-controls", map[string]any{"operationId": uuid.NewString(), "expectedRevision": 0, "reason": "Save the original rule before preparing its publication", "policy": policy}, func() (p.Actor, error) { return human, nil })
	if e != nil {
		t.Fatal(e)
	}
	service := &actions.Service{Pool: pool, Endpoint: endpoint, Permissions: permissions, Rules: rules, Now: now}
	operation := uuid.NewString()
	proposal, e := service.Prepare(ctx, human, "governance", map[string]any{"kind": "rule-publish", "key": "business-controls", "reason": "Publish the saved and reviewed rule"}, operation)
	if e != nil {
		t.Fatalf("purpose-bound rule preparation: %v", e)
	}
	if proposal["command"].(map[string]any)["versionId"] != saved["versionId"] {
		t.Fatal("card did not select the saved draft")
	}
	missing, e := service.RecoverPrepared(ctx, human, proposal, operation)
	if e != nil || missing["state"] != "not-recorded" {
		t.Fatalf("before execution: %v %#v", e, missing)
	}
	freshInTransaction := 0
	authorize := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		if tx == nil {
			return gateway.AuthorizeOperations(request, true, "workbench.read")
		}
		freshInTransaction++
		current, err := gateway.RequireWithin(ctx, tx, human, "workbench.read")
		if err != nil {
			return p.Actor{}, err
		}
		return permissions.HumanAIWithin(ctx, tx, current, "governance", "prepare", "rules.write")
	}
	execution, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result, e := service.ExecutePrepared(execution, human, proposal, operation, authorize)
	if e != nil || result["state"] != "completed" {
		t.Fatalf("owning publication: %v %#v", e, result)
	}
	if freshInTransaction < 2 {
		t.Fatalf("write did not revalidate current authority within its transaction: %d", freshInTransaction)
	}
	replay, e := service.ExecutePrepared(execution, human, proposal, operation, authorize)
	if e != nil || replay["state"] != "completed" {
		t.Fatalf("same operation replay: %v %#v", e, replay)
	}
	recovered, e := service.RecoverPrepared(execution, human, proposal, operation)
	if e != nil || recovered["state"] != "completed" {
		t.Fatalf("original receipt recovery: %v %#v", e, recovered)
	}
	receipt := recovered["receipt"].(map[string]any)
	if receipt["operationId"] != operation {
		t.Fatalf("recovery changed original operation: %#v", receipt)
	}
	var commands, events, published int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM operations_p14_rule_commands_v1 WHERE endpoint=$1 AND operation_id=$2`, endpoint, operation).Scan(&commands); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2 AND action='rule-save'`, endpoint, operation).Scan(&events); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM operations_product_rules_v1 WHERE endpoint=$1 AND policy_key='business-controls' AND version=2`, endpoint).Scan(&published); e != nil {
		t.Fatal(e)
	}
	if commands != 1 || events != 1 || published != 1 {
		t.Fatalf("duplicate owning write: commands=%d audit=%d publication=%d", commands, events, published)
	}
}
