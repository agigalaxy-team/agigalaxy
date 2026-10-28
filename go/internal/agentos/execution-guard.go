package agentos

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Executions) RequireExecutionWithin(ctx context.Context, tx pgx.Tx, id string, active bool) error {
	_, _, _, e := s.currentWithin(ctx, tx, id, ExecutionActorOptions{InactiveRead: !active})
	return e
}

// CurrentPreparedWithin is the strategy effect reader's current execution
// seam. It mints the same private actor after the original owner/action gate.
func (s *Executions) CurrentPreparedWithin(ctx context.Context, tx pgx.Tx, id string, owner *string) (*ExecutionRecord, operationspermissions.Actor, error) {
	row, _, _, e := s.currentWithin(ctx, tx, id, ExecutionActorOptions{})
	if e != nil {
		return nil, operationspermissions.Actor{}, e
	}
	if owner != nil && row.CreatedBy != *owner {
		return nil, operationspermissions.Actor{}, fail("p13_execution_not_found", 404)
	}
	if row.PreparedCommand == nil {
		return nil, operationspermissions.Actor{}, fail("operations_agentos_prepared_command_required", 409)
	}
	actor, e := s.ActorWithin(ctx, tx, id, ExecutionActorOptions{ResourceIDs: []string{text(row.PreparedCommand, "targetId")}})
	if e != nil {
		return nil, actor, e
	}
	action := "content.restore"
	if object(row.PreparedCommand["input"])["kind"] == "hide" {
		action = "content.hide"
	}
	actor, e = s.RequireExecutionAction(ctx, tx, actor, action)
	if e != nil {
		return nil, actor, e
	}
	actor, e = s.RequireExecutionAction(ctx, tx, actor, "content.read")
	return row, actor, e
}
func (s *Executions) CheckPriorDecisionWithin(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, command Object) error {
	return s.checkPriorDecision(ctx, tx, a, command)
}
func (s *Executions) checkPriorDecision(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, command Object) error {
	p, ok := s.proof(a)
	if !ok {
		return fail("business_admin_denied", 403)
	}
	target := "forum-reply"
	if command["targetKind"] == "post" {
		target = "forum-post"
	}
	var until *time.Time
	var operation *string
	e := tx.QueryRow(ctx, `SELECT hidden_until,operation_id::text FROM operations_content_visibility_v1 WHERE endpoint=$1 AND target_kind=$2 AND target_id=$3`, s.Endpoint, target, command["targetId"]).Scan(&until, &operation)
	if e == pgx.ErrNoRows {
		return nil
	}
	if e != nil {
		return e
	}
	if until != nil && until.After(s.now()) {
		var kind string
		var grant *string
		if operation == nil {
			return fail("operations_agentos_human_review_required", 409)
		}
		e = tx.QueryRow(ctx, `SELECT actor_kind,grant_id::text FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, *operation).Scan(&kind, &grant)
		if e != nil && e != pgx.ErrNoRows {
			return e
		}
		if kind != "operations-executor" || grant == nil || *grant != p.metadata["grantId"] {
			return fail("operations_agentos_human_review_required", 409)
		}
	}
	return nil
}

// GuardOperationWithin is called by the domain immediately before its own CAS
// command. A gateway preflight alone cannot protect an intervening decision.
func (s *Executions) GuardOperationWithin(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, action string, selection Object) error {
	if !s.AcceptsExecution(a) {
		return fail("business_admin_denied", 403)
	}
	if action != "community-content-visibility" {
		return nil
	}
	p, _ := s.proof(a)
	row, _, _, e := s.currentWithin(ctx, tx, p.id, ExecutionActorOptions{From: &a})
	if e != nil {
		return e
	}
	command := row.PreparedCommand
	input := object(command["input"])
	if command == nil || selection["id"] != command["targetId"] || selection["targetKind"] != command["targetKind"] || selection["kind"] != input["kind"] || !sameConversationJSON([]any{selection["expectedVersion"], selection["expectedRevision"]}, []any{input["expectedVersion"], input["expectedRevision"]}) {
		return fail("operations_agentos_scope_denied", 403)
	}
	return s.checkPriorDecision(ctx, tx, a, command)
}

// The strategy owner uses this thin adapter; it is the same opaque execution
// proof and same current selected-object restriction as every other consumer.
func (s *Executions) AcceptsExecutor(a operationspermissions.Actor) bool {
	return s.AcceptsExecution(a)
}
func (s *Executions) ExecutorMetadata(a operationspermissions.Actor) (Object, error) {
	return s.ExecutionMetadata(a)
}
func (s *Executions) RequireSelectedWithin(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, action, id string, input Object) (operationspermissions.Actor, error) {
	selection := Object{"id": id}
	for k, v := range input {
		selection[k] = v
	}
	selection["id"] = id
	return s.RequireExecutionOperation(ctx, tx, a, []string{action}, selection)
}
