package operationsfixture

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// These readers use a separately authenticated current Go service instance.
// Tests compare its domain results with the public HTTP/action boundary while
// fixed original schema/byte fixtures cover the retained wire representation.
func checked(t *testing.T) func(Object, error) Object {
	return func(value Object, err error) Object {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
}

func (f *Fixture) Read(t *testing.T, input Object) Object {
	t.Helper()
	ctx := context.Background()
	read := checked(t)
	out := Object{"catalog": read(f.Permissions.Catalog(ctx, f.Root)), "roles": read(f.Permissions.Roles(ctx, f.Root)), "personnel": read(f.Permissions.Personnel(ctx, f.Root)), "history": read(f.Permissions.History(ctx, f.Root, Object{"limit": 100}))}
	if id, ok := input["operationId"].(string); ok {
		out["operation"] = read(f.Permissions.Operation(ctx, f.Root, id))
	}
	return out
}

func (f *Fixture) AutomationRead(t *testing.T, input Object) Object {
	t.Helper()
	ctx := context.Background()
	read := checked(t)
	authorization, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (any, error) {
		return f.Permissions.AIWork.AuthorizationWithin(ctx, tx, "governance", nil)
	})
	if err != nil {
		t.Fatal(err)
	}
	out := Object{"automation": read(f.Permissions.Automation(ctx, f.Root)), "delegation": read(f.Permissions.Delegation(ctx, f.Root)), "authorization": authorization, "history": read(f.Permissions.History(ctx, f.Root, Object{"limit": 100}))}
	if id, ok := input["operationId"].(string); ok {
		out["operation"] = read(f.Permissions.Operation(ctx, f.Root, id))
	}
	if id, ok := input["delegationOperationId"].(string); ok {
		out["delegationOperation"] = read(f.Permissions.DelegationOperation(ctx, f.Root, id))
	}
	return out
}

func (f *Fixture) AIRead(t *testing.T, input Object) Object {
	t.Helper()
	ctx := context.Background()
	read := checked(t)
	domain := "governance"
	if value, ok := input["domain"].(string); ok {
		domain = value
	}
	out := Object{"list": read(f.Permissions.AIWorkList(ctx, f.Root)), "detail": read(f.Permissions.AIWorkDetail(ctx, f.Root, domain)), "history": read(f.Permissions.AIWorkHistory(ctx, f.Root, domain, Object{})), "runtime": read(f.Permissions.AIWorkRuntime(ctx, f.Root, domain))}
	if id, ok := input["operationId"].(string); ok {
		out["operation"] = read(f.Permissions.AIWorkOperation(ctx, f.Root, id))
	}
	return out
}

func (f *Fixture) AICommand(t *testing.T, input Object) Object {
	t.Helper()
	command, _ := input["command"].(map[string]any)
	domain, _ := input["domain"].(string)
	return checked(t)(f.Permissions.AIWorkCommand(context.Background(), f.Root, domain, command))
}

func (f *Fixture) queryActor(t *testing.T) operationspermissions.Actor {
	t.Helper()
	ctx := context.Background()
	actor, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (operationspermissions.Actor, error) {
		return f.Permissions.HumanAIWithin(ctx, tx, f.Root, "overview", "query", "workbench.read")
	})
	if err != nil {
		t.Fatal(err)
	}
	return actor
}

func (f *Fixture) DelegatedRead(t *testing.T, input Object) Object {
	t.Helper()
	ctx := context.Background()
	read := checked(t)
	actor := f.queryActor(t)
	capabilities, err := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (Object, error) { return f.Permissions.ManagementCapabilitiesWithin(ctx, tx, actor) })
	if err != nil {
		t.Fatal(err)
	}
	out := Object{"actor": Object{"version": actor.Version, "permissions": actor.Permissions}, "directory": read(f.Permissions.DelegatedDirectory(ctx, actor)), "capabilities": capabilities}
	if id, ok := input["operationId"].(string); ok {
		out["operation"] = read(f.Permissions.DelegatedManagementOperation(ctx, actor, id, nil, nil))
	}
	if id, ok := input["aiAccountId"].(string); ok {
		out["prompt"] = read(f.Permissions.DelegatedPrompt(ctx, actor, Object{"aiAccountId": id}))
	}
	if value, ok := input["prepare"].(map[string]any); ok {
		out["preparation"] = read(f.Permissions.DelegatedRolePreparation(ctx, actor, value))
	}
	return out
}

func (f *Fixture) PrepareAction(t *testing.T, input Object) Object {
	t.Helper()
	request, _ := input["request"].(map[string]any)
	operation, _ := input["operationId"].(string)
	return checked(t)(f.Permissions.PrepareManagementAction(context.Background(), f.Root, "overview", request, operation))
}
func (f *Fixture) RecoverAction(t *testing.T, input Object) Object {
	t.Helper()
	proposal, _ := input["proposal"].(map[string]any)
	operation, _ := input["operationId"].(string)
	return checked(t)(f.Permissions.RecoverManagementAction(context.Background(), f.Root, proposal, operation))
}
func (f *Fixture) ExecuteAction(t *testing.T, input Object) Object {
	t.Helper()
	proposal, _ := input["proposal"].(map[string]any)
	operation, _ := input["operationId"].(string)
	return checked(t)(f.Permissions.ExecuteManagementAction(context.Background(), f.Root, proposal, operation, func(context.Context) (operationspermissions.Actor, error) { return f.Root, nil }))
}
func (f *Fixture) ReadManagement(t *testing.T, input Object) Object {
	t.Helper()
	arguments, _ := input["arguments"].(map[string]any)
	return checked(t)(f.Permissions.ReadManagementTool(context.Background(), f.Root, "overview", arguments))
}
