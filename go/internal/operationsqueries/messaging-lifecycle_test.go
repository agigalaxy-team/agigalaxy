package operationsqueries

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
)

func TestMessageLifecycleUsesOnlyCurrentDomainFacts(t *testing.T) {
	input := Object{"id": "plan-1", "state": "draft", "effectiveState": "draft", "capabilities": Object{"canSave": true, "canActivate": true, "canPause": false, "canResume": false, "canStop": false, "canWithdraw": true}}
	lifecycle := messageLifecycle(input, true)
	options := lifecycle["preparationOptions"].([]any)
	if len(options) != 6 {
		t.Fatalf("options %#v", options)
	}
	save, activate := object(options[0]), object(options[1])
	if save["kind"] != "message-draft-save" || save["effect"] != "save-draft-only" || save["eligibleNow"] != true || save["action"] != nil {
		t.Fatalf("save %#v", save)
	}
	if activate["kind"] != "messaging-state" || activate["action"] != "activate" || activate["eligibleNow"] != true || activate["effect"] != "schedule-delivery-after-confirmation" || activate["requiresHumanConfirmation"] != true {
		t.Fatalf("activate %#v", activate)
	}
	paused := messageLifecycle(Object{"id": "plan-1", "state": "paused", "capabilities": Object{"canSave": true}}, true)
	if object(paused["capabilities"])["canSave"] != true || object(paused["preparationOptions"].([]any)[0])["eligibleNow"] != false {
		t.Fatalf("paused draft card %#v", paused)
	}
	missing := messageLifecycle(Object{"id": "plan-1", "capabilities": Object{"canSave": false}}, true)
	if object(missing["capabilities"])["canSave"] != false || object(missing["capabilities"])["canActivate"] != nil {
		t.Fatalf("missing capability %#v", missing)
	}
	unknown := messageLifecycle(input, false)
	if unknown["availability"] != "not-checked" || object(unknown["capabilities"])["canActivate"] != nil {
		t.Fatalf("duty facts %#v", unknown)
	}
}

func TestMessageLifecycleExactReadUsesPreparationAuthority(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	f.Automation(t)
	fixture := seedQueryMessaging(t, f)
	role, err := f.Permissions.SaveRole(context.Background(), f.Root, Object{"operationId": uuid.NewString(), "expectedVersion": 0, "name": "Messaging lifecycle preparer", "description": "Synthetic lifecycle preparation", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"notices.read", "notices.update", "notices.publish", "notices.withdraw"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Permissions.AIWorkAssignment(context.Background(), f.Root, "messaging", Object{"operationId": uuid.NewString(), "expectedVersion": 0, "roleId": object(role["role"])["id"], "enabled": true}); err != nil {
		t.Fatal(err)
	}
	source := &messaging.Service{Pool: f.Pool, Endpoint: f.Endpoint, Authority: f.Gateway, Now: f.Now}
	queries := &Service{Pool: f.Pool, Permissions: f.Permissions, Messaging: source, Now: f.Now}
	planID := str(object(fixture["created"])["planId"])
	if planID == "" {
		planID = str(object(object(fixture["created"])["plan"])["id"])
	}
	response, err := queries.Query(context.Background(), f.Root, "messaging", "read-operation-object", Object{"kind": "message-plan", "id": planID})
	if err != nil {
		t.Fatal(err)
	}
	lifecycle := object(object(response["data"])["lifecycle"])
	caps := object(lifecycle["capabilities"])
	if lifecycle["availability"] != "available" || caps["canSave"] != true || caps["canActivate"] != true || caps["canPause"] != false {
		t.Fatalf("actual preparation facts %#v", lifecycle)
	}
	if response["purpose"] != "message-draft-editing" {
		t.Fatalf("source purpose changed: %#v", response["purpose"])
	}
	original := object(role["role"])
	_, err = f.Permissions.SaveRole(context.Background(), f.Root, Object{"id": original["id"], "operationId": uuid.NewString(), "expectedVersion": original["version"], "name": "Messaging lifecycle preparer", "description": "Synthetic lifecycle preparation", "subjectScope": "ai-only", "enabled": true, "permissions": []any{"notices.read", "notices.update", "notices.withdraw"}})
	if err != nil {
		t.Fatal(err)
	}
	response, err = queries.Query(context.Background(), f.Root, "messaging", "read-operation-object", Object{"kind": "message-plan", "id": planID})
	if err != nil {
		t.Fatal(err)
	}
	caps = object(object(object(response["data"])["lifecycle"])["capabilities"])
	if caps["canActivate"] != false || caps["canSave"] != true {
		t.Fatalf("current AI permission projection %#v", caps)
	}
}
