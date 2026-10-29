package actions

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"slices"
	"time"
)

func missing(operationID string) Object {
	return Object{"operationId": operationID, "state": "not-recorded", "summary": "尚未记录本次处理。", "receipt": nil}
}
func (s *Service) RecoverPrepared(ctx context.Context, a Actor, proposal Object, operationID string) (Object, error) {
	if slices.Contains([]string{"ai-role-command", "ai-work-prompt-save"}, str(proposal["kind"])) {
		return s.Permissions.RecoverManagementAction(ctx, a, proposal, operationID)
	}
	x, command, e := s.proposal(proposal, operationID)
	if e != nil {
		return nil, e
	}
	kind := str(x["kind"])
	read, e := CardReadPermission(kind)
	if e != nil {
		return nil, e
	}
	purpose := "query"
	if kind == "private-case-message" {
		purpose = "prepare"
	}
	actor, e := s.human(ctx, a, str(proposal["domain"]), read, purpose, nil)
	if e != nil {
		return nil, e
	}
	var result Object
	var finalCard Object
	if recommendationExtended(kind) {
		result, e = s.recoverRecommendationExtended(ctx, actor, x, command, operationID)
		if e != nil {
			return nil, e
		}
		if result == nil {
			return missing(operationID), nil
		}
		if result["state"] == "unknown" {
			return result, nil
		}
	} else if noticeKind(kind) {
		result, e = s.recoverNotice(ctx, actor, x, command, operationID)
		if e != nil {
			return nil, e
		}
		if result == nil {
			return missing(operationID), nil
		}
		if result["state"] == "unknown" {
			return result, nil
		}
	} else if strategyRuleKind(kind) {
		result, finalCard, e = s.recoverStrategyRule(ctx, actor, x, command, operationID)
		if e != nil {
			return nil, e
		}
		if result == nil {
			return missing(operationID), nil
		}
	} else if kind == "search-draft-save" || kind == "search-apply" || kind == "search-restore" || kind == "recommendation-direction" {
		result, e = s.recoverDiscovery(ctx, actor, x, command, operationID)
		if e != nil {
			return nil, e
		}
		if result == nil {
			return missing(operationID), nil
		}
	} else if kind == "job-cancel" || kind == "job-retry" || kind == "search-retry" {
		service, err := s.jobActions(actor)
		if err != nil {
			return nil, err
		}
		result, e = service.Operation(ctx, actor, kind, x, command, operationID)
		if e != nil {
			return nil, e
		}
		if result == nil {
			return missing(operationID), nil
		}
	} else if kind == "private-case-message" {
		if s.isDuty(actor) {
			service, err := s.chatReports(actor)
			if err != nil {
				return nil, err
			}
			_, err = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
				err := service.AssertDutyCaseWithin(ctx, tx, actor, str(x["reportId"]))
				return err == nil, err
			})
			if err != nil {
				return nil, err
			}
		}
		var eventKind, owner string
		var version int64
		var input, audit Object
		e = s.Pool.QueryRow(ctx, `SELECT actor_kind,operator_id,version,input FROM account_chat_governance_events_v1 WHERE id=$1 AND report_id=$2`, operationID, x["reportId"]).Scan(&eventKind, &owner, &version, &input)
		if e == pgx.ErrNoRows {
			return missing(operationID), nil
		}
		if e != nil {
			return nil, e
		}
		e = s.Pool.QueryRow(ctx, `SELECT result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2 AND action='chat-report-event'`, s.Endpoint, operationID).Scan(&audit)
		if e == pgx.ErrNoRows {
			return missing(operationID), nil
		}
		if e != nil {
			return nil, e
		}
		expected := clone(command)
		expected["reportId"], expected["messageId"], expected["kind"] = x["reportId"], x["messageId"], "message-"+str(x["action"])
		expectedKind := "business-operator"
		if s.isDuty(actor) {
			expectedKind = "operations-ai-service"
		}
		if eventKind != expectedKind || owner != actor.ID || !same(input, expected) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		result = Object{"operationId": operationID, "reportId": x["reportId"], "version": version, "revision": audit["revision"], "replayed": true}
	} else if kind == "feedback-update" {
		service, err := s.feedback(actor)
		if err != nil {
			return nil, err
		}
		saved, err := service.Operation(ctx, actor, str(x["targetId"]), operationID)
		if err != nil {
			return nil, err
		}
		if saved["state"] == "not-recorded" {
			return missing(operationID), nil
		}
		expected := pick(command, "expectedRevision", "category", "module", "state")
		expected["noteHash"] = nil
		if note := str(command["note"]); note != "" {
			expected["noteHash"] = identity.Digest([]byte(note))
		}
		if saved["state"] != "recorded" || saved["operationId"] != operationID || saved["feedbackId"] != x["targetId"] || saved["action"] != "feedback-update" || !same(saved["selection"], expected) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		result = clone(obj(saved["result"]))
		result["replayed"] = saved["replayed"] == true
	} else if kind == "message-draft-create" || kind == "message-draft-save" || kind == "messaging-state" {
		var owner, savedKind string
		var input Object
		e = s.Pool.QueryRow(ctx, `SELECT operator_id,kind,input,result FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID).Scan(&owner, &savedKind, &input, &result)
		if e != nil && e != pgx.ErrNoRows {
			return nil, e
		}
		if kind == "messaging-state" {
			if e == pgx.ErrNoRows {
				return missing(operationID), nil
			}
			expected := clone(command)
			expected["planId"] = x["targetId"]
			if owner != actor.ID || savedKind != x["action"] || !same(input, expected) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
		} else {
			service, err := s.messages(actor)
			if err != nil {
				return nil, err
			}
			saved, err := service.CommandResult(ctx, actor, operationID)
			if err != nil {
				return nil, err
			}
			if e == pgx.ErrNoRows {
				if saved["state"] == "recorded" {
					return nil, fail("operations_agentos_operation_conflict", 409)
				}
				return missing(operationID), nil
			}
			create := kind == "message-draft-create"
			id, method := x["targetId"], "save"
			expected := clone(command)
			if create {
				id, method = operationID, "create"
			} else {
				expected["planId"] = id
			}
			recorded := obj(saved["result"])
			plan := obj(result["plan"])
			if owner != actor.ID || savedKind != method || !same(input, expected) || saved["state"] != "recorded" || saved["operationId"] != operationID || recorded["planId"] != id || recorded["state"] != "draft" || !same(recorded["version"], plan["version"]) || !same(recorded["revision"], plan["revision"]) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			result["replayed"] = true
		}
	} else if kind == "account-restriction" {
		var owner, account, action string
		var selection Object
		e = s.Pool.QueryRow(ctx, `SELECT operator_id,account_id::text,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID).Scan(&owner, &account, &action, &selection, &result)
		if e == pgx.ErrNoRows {
			return missing(operationID), nil
		}
		if e != nil {
			return nil, e
		}
		expected := "restriction-set"
		if x["action"] == "release" {
			expected = "restriction-release"
		}
		if owner != actor.ID || account != x["targetId"] || action != expected || !same(selection, command) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
	} else if kind == "file-access" {
		service, e := s.files(actor)
		if e != nil {
			return nil, e
		}
		saved, e := service.AccessOperation(ctx, actor, operationID)
		if e != nil {
			return nil, e
		}
		var owner, fileKind, id, action, version, reason string
		var revision, expected int64
		var until *time.Time
		e = s.Pool.QueryRow(ctx, `SELECT operator_id,kind,file_id::text,action,expected_version,expected_revision,reason,stopped_until,revision FROM operations_file_access_events_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID).Scan(&owner, &fileKind, &id, &action, &version, &expected, &reason, &until, &revision)
		if e == pgx.ErrNoRows {
			if saved["state"] == "recorded" {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			return missing(operationID), nil
		}
		if e != nil {
			return nil, e
		}
		var at any
		if until != nil {
			at = until.Unix()
		}
		if owner != actor.ID || fileKind != x["targetKind"] || id != x["targetId"] || action != x["action"] || version != command["expectedVersion"] || expected != num(command["expectedRevision"]) || reason != command["reason"] || !same(at, command["until"]) || saved["state"] != "recorded" || num(saved["revision"]) != revision {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		result = clone(saved)
		result["replayed"] = true
	} else {
		var owner, action string
		var selection Object
		e = s.Pool.QueryRow(ctx, `SELECT operator_id,action,selection,result FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2`, s.Endpoint, operationID).Scan(&owner, &action, &selection, &result)
		if e == pgx.ErrNoRows {
			return missing(operationID), nil
		}
		if e != nil {
			return nil, e
		}
		if owner != actor.ID {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		if kind == "public-content-batch" {
			expected := clone(command)
			delete(expected, "reason")
			expected["reasonDigest"] = identity.Digest([]byte(str(command["reason"])))
			if action != "community-content-batch-visibility" || !same(expected, selection) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
		} else if kind == "file-cleanup-approve" {
			if action != "file-cleanup-approve" || !same(selection, Object{"operationId": operationID, "id": x["planId"], "command": command, "resourceId": x["planId"]}) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			service, e := s.files(actor)
			if e != nil {
				return nil, e
			}
			saved, e := service.CleanupOperation(ctx, actor, operationID)
			if e != nil {
				return nil, e
			}
			if saved["state"] != "recorded" {
				return missing(operationID), nil
			}
			if saved["kind"] != "approve" || saved["planId"] != x["planId"] {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			plan, e := service.CleanupPlan(ctx, actor, str(x["planId"]))
			if e != nil {
				return nil, e
			}
			result = clone(result)
			result["plan"] = plan
		} else {
			actions := map[string]string{"content-visibility": "community-content-visibility", "content-curation": "community-content-curation", "file-scan-retry": "file-retry", "section-classification": "community-section-classify", "section-visibility": "community-section-visibility", "resource-visibility": "resource-visibility", "case-resolve": "community-report-resolve"}
			if action != actions[kind] || selection["id"] != x["targetId"] {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			selectedKind := selection["kind"]
			if kind == "content-visibility" {
				selectedKind = selection["targetKind"]
			}
			if x["targetKind"] != nil && selectedKind != x["targetKind"] {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
		}
	}
	if _, e = s.human(ctx, actor, str(proposal["domain"]), read, purpose, nil); e != nil {
		return nil, e
	}
	if finalCard != nil {
		return finalCard, nil
	}
	result, e = wire(result)
	if e != nil {
		return nil, e
	}
	if kind == "message-draft-create" || kind == "message-draft-save" {
		return messageDraftResult(kind, result, operationID, x, command, true)
	}
	if kind == "feedback-update" {
		return feedbackResult(result, operationID, x, command, true)
	}
	if kind == "search-draft-save" || kind == "search-apply" || kind == "search-restore" || kind == "recommendation-direction" {
		return discoveryResult(kind, result, operationID, x, command, true)
	}
	return actionResult(kind, result, operationID, x, command)
}
