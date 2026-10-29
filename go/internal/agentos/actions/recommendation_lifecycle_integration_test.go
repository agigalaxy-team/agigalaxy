package actions_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestRecommendationExistingThemeUpdateAndOriginalRecoveryPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, e := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Recommendation review", "description": "Isolated theme review", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"recommendations.read", "recommendations.configure"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "discovery", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	source := &discovery.Recommendations{Pool: f.Pool, Endpoint: f.Endpoint, Authority: &p.BusinessAuthority{Human: f.Gateway}, Now: f.Now}
	mapping := map[string]any{"categories": []any{"technology"}, "tagIds": []any{}, "queryTerms": []any{}}
	created, e := source.SaveTheme(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "label": "Existing theme", "enabled": true, "mapping": mapping, "reason": "Create test theme"})
	if e != nil {
		t.Fatal(e)
	}
	id := created["theme"].(map[string]any)["id"]
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, Recommendations: source, Now: f.Now}
	_, e = service.Prepare(ctx, f.Root, "discovery", map[string]any{"kind": "recommendation-policy-save", "expectedVersion": 0, "enabled": true, "controls": map[string]any{"avoidRepetition": true, "avoidConcentration": true}, "reason": "No anchor"}, uuid.NewString())
	if fault.Code(e) != "recommendation_policy_anchor_unavailable" {
		t.Fatalf("empty policy must not invent a theme: %v", e)
	}

	_, e = source.SavePolicy(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "enabled": true, "themeKey": "theme:" + id.(string), "direction": "increase", "controls": map[string]any{"avoidRepetition": true, "avoidConcentration": true}, "reason": "Seed existing direction"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	op := uuid.NewString()
	request := map[string]any{"kind": "recommendation-theme-update", "themeId": id, "expectedVersion": 1, "label": "Updated theme", "enabled": true, "mapping": mapping, "reason": "Reviewed mapping"}
	proposal, e := service.Prepare(ctx, f.Root, "discovery", request, op)
	if e != nil {
		t.Fatal(e)
	}
	auth := func(ctx context.Context, tx pgx.Tx) (p.Actor, error) {
		read := func(tx pgx.Tx) (p.Actor, error) {
			return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "discovery", "query", "recommendations.read")
		}
		if tx != nil {
			return read(tx)
		}
		return postgres.InTx(ctx, f.Pool, read)
	}
	result, e := service.ExecutePrepared(ctx, f.Root, proposal, op, auth)
	if e != nil || result["state"] != "completed" {
		t.Fatalf("execute: %#v %v", result, e)
	}
	recovered, e := service.RecoverPrepared(ctx, f.Root, proposal, op)
	if e != nil || recovered["state"] != "completed" {
		t.Fatalf("recover: %#v %v", recovered, e)
	}
	raw, _ := json.Marshal(proposal)
	var forged map[string]any
	_ = json.Unmarshal(raw, &forged)
	forged["request"].(map[string]any)["label"] = "changed intent"
	forged["command"].(map[string]any)["label"] = "changed intent"
	if _, e = service.RecoverPrepared(ctx, f.Root, forged, op); e == nil {
		t.Fatal("original recommendation operation must reject altered intent")
	}
	policyOp := uuid.NewString()
	policyRequest := map[string]any{"kind": "recommendation-policy-save", "expectedVersion": 1, "enabled": true, "controls": map[string]any{"avoidRepetition": false, "avoidConcentration": true}, "reason": "Reviewed controls"}
	policyCard, e := service.Prepare(ctx, f.Root, "discovery", policyRequest, policyOp)
	if e != nil {
		t.Fatal(e)
	}
	policyResult, e := service.ExecutePrepared(ctx, f.Root, policyCard, policyOp, auth)
	if e != nil || policyResult["state"] != "completed" {
		t.Fatalf("policy execute: %#v %v", policyResult, e)
	}
	policyRecovered, e := service.RecoverPrepared(ctx, f.Root, policyCard, policyOp)
	if e != nil || policyRecovered["state"] != "completed" {
		t.Fatalf("policy recover: %#v %v", policyRecovered, e)
	}
}
