package actions_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos/actions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestSearchRestoreOriginalRecoverySeparatesSourceAndResultPG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	ctx := context.Background()
	role, e := f.Permissions.SaveRole(ctx, f.Root, map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Restore recovery", "description": "Original recovery", "subjectScope": "ai-only", "enabled": true, "permissions": []string{"search-quality.read", "search-quality.restore", "search-quality.publish", "search-quality.configure"}})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Permissions.AIWorkAssignment(ctx, f.Root, "discovery", map[string]any{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": role["role"].(map[string]any)["id"], "enabled": true}); e != nil {
		t.Fatal(e)
	}
	source := &discovery.SearchQuality{Pool: f.Pool, Endpoint: f.Endpoint, Authority: &p.BusinessAuthority{Human: f.Gateway}, Now: f.Now}
	service := &actions.Service{Pool: f.Pool, Endpoint: f.Endpoint, Permissions: f.Permissions, SearchQuality: source, Now: f.Now}
	settings := map[string]any{"synonyms": []any{}, "rankingMode": "relevance", "fixedConstraints": map[string]any{"currentSource": true, "anonymousPublic": true, "withdrawnExcluded": true, "expiredExcluded": true}}
	settingsRaw, _ := json.Marshal(settings)
	nativeRaw := []byte(`{"synonyms":{},"rankingRules":["words","typo","proximity","attribute","sort","exactness"]}`)
	version := 0
	addVersion := func(kind string, from any) string {
		t.Helper()
		id := uuid.NewString()
		version++
		_, e := owner.Exec(ctx, `INSERT INTO operations_search_quality_versions_v1(id,endpoint,version,settings,native_settings,kind,restored_from,operator_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, f.Endpoint, version, settingsRaw, nativeRaw, kind, from, f.Root.ID, f.Now())
		if e != nil {
			t.Fatal(e)
		}
		return id
	}
	sourceID := addVersion("draft", nil)
	// The current head has subsequently moved; original recovery must use
	// immutable operation/version records rather than the latest head.
	_, e = owner.Exec(ctx, `INSERT INTO operations_search_quality_state_v1(endpoint,revision,active_id,updated_at) VALUES($1,99,$2,$3)`, f.Endpoint, sourceID, f.Now())
	if e != nil {
		t.Fatal(e)
	}
	makeRecord := func(method, phase, outputID string, command map[string]any) map[string]any {
		t.Helper()
		op := command["operationId"].(string)
		raw, _ := json.Marshal(command)
		canonical, e := identity.Canonical(map[string]any{"kind": method, "input": command})
		if e != nil {
			t.Fatal(e)
		}
		digest := sha256.Sum256(canonical)
		_, e = owner.Exec(ctx, `INSERT INTO operations_search_quality_operations_v1(endpoint,operation_id,operator_id,kind,request_hash,input,version_id,phase,changes,reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'{}',$9,$10,$10)`, f.Endpoint, op, f.Root.ID, method, hex.EncodeToString(digest[:]), raw, outputID, phase, command["reason"], f.Now())
		if e != nil {
			t.Fatal(e)
		}
		request := map[string]any{"kind": "search-" + method, "reason": command["reason"]}
		if method == "draft" {
			request["kind"] = "search-draft-save"
			request["settings"] = command["settings"]
		}
		if method == "restore" {
			request["versionId"] = command["versionId"]
		}
		return map[string]any{"schemaVersion": 1, "kind": request["kind"], "domain": "discovery", "request": request, "command": command, "requiredAction": map[string]string{"draft": "search-quality.configure", "apply": "search-quality.publish", "restore": "search-quality.restore"}[method]}
	}
	for _, phase := range []string{"applied", "failed", "prepared"} {
		op := uuid.NewString()
		target := addVersion("restore", sourceID)
		command := map[string]any{"operationId": op, "expectedRevision": 0, "versionId": sourceID, "reason": "Restore source"}
		proposal := makeRecord("restore", phase, target, command)
		got, e := service.RecoverPrepared(ctx, f.Root, proposal, op)
		expected := map[string]string{"applied": "completed", "failed": "failed", "prepared": "processing"}[phase]
		if e != nil || got["state"] != expected {
			t.Fatalf("restore phase %s: %#v %v", phase, got, e)
		}
		if phase == "applied" {
			_, e = owner.Exec(ctx, `UPDATE operations_search_quality_versions_v1 SET restored_from=$2 WHERE id=$1`, target, uuid.NewString())
			if e != nil {
				t.Fatal(e)
			}
			if _, e = service.RecoverPrepared(ctx, f.Root, proposal, op); fault.Code(e) != "operations_agentos_operation_conflict" {
				t.Fatalf("changed restoredFrom: %v", e)
			}
			_, e = owner.Exec(ctx, `UPDATE operations_search_quality_versions_v1 SET restored_from=$2 WHERE id=$1`, target, sourceID)
			if e != nil {
				t.Fatal(e)
			}
			_, e = owner.Exec(ctx, `UPDATE operations_search_quality_versions_v1 SET native_settings='{}'::jsonb WHERE id=$1`, target)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = service.RecoverPrepared(ctx, f.Root, proposal, op); fault.Code(e) != "operations_agentos_operation_conflict" {
				t.Fatalf("changed restore native settings: %v", e)
			}
			_, e = owner.Exec(ctx, `UPDATE operations_search_quality_versions_v1 SET native_settings=$2 WHERE id=$1`, target, nativeRaw)
			if e != nil {
				t.Fatal(e)
			}
			_, e = owner.Exec(ctx, `UPDATE operations_search_quality_operations_v1 SET request_hash='wrong' WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = service.RecoverPrepared(ctx, f.Root, proposal, op); fault.Code(e) != "operations_agentos_operation_conflict" {
				t.Fatalf("changed hash: %v", e)
			}
		}
	}
	for _, method := range []string{"apply", "draft"} {
		op := uuid.NewString()
		target := sourceID
		command := map[string]any{"operationId": op, "expectedRevision": 0, "reason": "Review"}
		if method == "apply" {
			command["versionId"] = sourceID
		} else {
			target = addVersion("draft", nil)
			command["settings"] = settings
			command["expectedDraftId"] = nil
		}
		proposal := makeRecord(method, "applied", target, command)
		got, e := service.RecoverPrepared(ctx, f.Root, proposal, op)
		if e != nil || got["state"] != "completed" {
			t.Fatalf("%s recovery: %#v %v", method, got, e)
		}
		if method == "apply" {
			other := addVersion("draft", nil)
			_, e = owner.Exec(ctx, `UPDATE operations_search_quality_operations_v1 SET version_id=$3 WHERE endpoint=$1 AND operation_id=$2`, f.Endpoint, op, other)
			if e != nil {
				t.Fatal(e)
			}
		} else {
			_, e = owner.Exec(ctx, `UPDATE operations_search_quality_versions_v1 SET settings='{}'::jsonb WHERE id=$1`, target)
			if e != nil {
				t.Fatal(e)
			}
		}
		if _, e = service.RecoverPrepared(ctx, f.Root, proposal, op); fault.Code(e) != "operations_agentos_operation_conflict" {
			t.Fatalf("%s mismatched output: %v", method, e)
		}
	}
}
