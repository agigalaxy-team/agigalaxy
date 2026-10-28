package messaging

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *Service) NoticeCommandResult(ctx context.Context, a Actor, operationID string) (Object, error) {
	if !uuidOK(operationID) {
		return nil, failure("invalid_operations_command_receipt", 400)
	}
	check := func() error {
		_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.require(ctx, tx, a, "notices.read") })
		return e
	}
	if e := check(); e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, "SELECT to_jsonb(c) FROM operations_product_commands_v1 c WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, operationID)
	state := "not-recorded"
	var kind, result any
	if e != nil {
		if !missingTable(e) {
			return nil, failure("operations_command_receipt_unavailable", 503)
		}
		state = "unknown"
	} else if len(rows) > 0 {
		state = "unknown"
		for _, row := range rows {
			if str(row["operator_id"]) != a.ID {
				if e := check(); e != nil {
					return nil, e
				}
				return nil, failure("operations_command_receipt_not_found", 404)
			}
		}
		if len(rows) == 1 {
			row := rows[0]
			action := str(row["action"])
			input := obj(clone(row["input"]))
			valid := contains([]string{"notice-create", "notice-save", "notice-publish", "notice-withdraw"}, action) && str(input["operationId"]) == operationID
			allowed := []string{"operationId", "content"}
			if action != "notice-create" {
				allowed = []string{"operationId", "expectedVersion", "noticeId"}
				valid = valid && uuidOK(input["noticeId"]) && intOK(input["expectedVersion"], 1, 9007199254740991)
				if action == "notice-save" {
					allowed = append(allowed, "content")
					valid = valid && intOK(input["expectedVersion"], 1, 2147483646)
				}
			}
			valid = valid && keys(input, allowed...)
			if action == "notice-create" || action == "notice-save" {
				content, e := noticeContent(input["content"])
				if e != nil {
					valid = false
				} else {
					input["content"] = content
				}
			}
			notice := obj(obj(row["result"])["notice"])
			id := input["noticeId"]
			if action == "notice-create" {
				id = operationID
			}
			expectedState := "draft"
			if action == "notice-publish" {
				expectedState = "queued"
			} else if action == "notice-withdraw" {
				expectedState = "withdrawn"
			}
			version := num(input["expectedVersion"]) + 1
			valid = valid && uuidOK(notice["id"]) && str(notice["id"]) == str(id) && num(notice["version"]) == version && str(notice["state"]) == expectedState && (notice["jobId"] == nil || uuidOK(notice["jobId"])) && (action != "notice-publish" || notice["jobId"] != nil)
			recorded := stamp(row["created_at"])
			valid = valid && recorded != nil
			if valid {
				canonical, e := identity.Canonical(Object{"action": action, "input": input})
				if e == nil {
					state = "recorded"
					kind = action
					result = Object{"noticeId": notice["id"], "version": notice["version"], "state": notice["state"], "submittedJobId": notice["jobId"], "recordedAt": recorded, "intentHash": identity.Digest(canonical)}
				}
			}
		}
	}
	if e := check(); e != nil {
		return nil, e
	}
	return Object{"state": state, "operationId": operationID, "kind": kind, "result": result, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30, "metadataOnly": true}, nil
}
func (s *SMTPService) CommandResult(ctx context.Context, a Actor, operationID string) (Object, error) {
	if !uuidOK(operationID) {
		return nil, failure("invalid_operations_command_receipt", 400)
	}
	check := func() error {
		_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.require(ctx, tx, a, "smtp.read") })
		return e
	}
	if e := check(); e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, `SELECT jsonb_build_object('operator_id',operator_id,'kind','settings','receipt',jsonb_build_object('version',result->'version')) FROM operations_smtp_commands_v1 WHERE endpoint=$1 AND operation_id=$2 UNION ALL SELECT jsonb_build_object('operator_id',operator_id,'kind','test.'||kind,'receipt',jsonb_build_object('version',configuration_version,'testId',id,'state',state,'code',code,'startedAt',started_at)) FROM operations_smtp_tests_v1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, operationID)
	state := "not-recorded"
	var kind, result any
	if e != nil {
		if !missingTable(e) {
			return nil, failure("operations_command_receipt_unavailable", 503)
		}
		state = "unknown"
	} else if len(rows) > 0 {
		state = "unknown"
		for _, row := range rows {
			if str(row["operator_id"]) != a.ID {
				if e := check(); e != nil {
					return nil, e
				}
				return nil, failure("operations_command_receipt_not_found", 404)
			}
		}
		if len(rows) == 1 {
			row := rows[0]
			receipt := obj(row["receipt"])
			valueKind := str(row["kind"])
			if intOK(receipt["version"], 1, 9007199254740991) {
				if valueKind == "settings" {
					state = "recorded"
					kind = valueKind
					result = Object{"version": receipt["version"]}
				} else if contains([]string{"test.connection", "test.delivery"}, valueKind) && uuidOK(receipt["testId"]) && contains([]string{"testing", "connected", "submitted", "not-configured", "ineligible", "failed", "unknown"}, str(receipt["state"])) {
					valueState, code := receipt["state"], receipt["code"]
					started, e := date(receipt["startedAt"])
					if str(valueState) == "testing" && e == nil && s.now().Sub(started) > 15*time.Minute {
						valueState = "unknown"
						code = "smtp_submission_unknown"
					} else if !safeProviderCodes[str(code)] {
						code = nil
					}
					state = "recorded"
					kind = valueKind
					result = Object{"version": receipt["version"], "testId": receipt["testId"], "state": valueState, "code": code}
				}
			}
		}
	}
	if e := check(); e != nil {
		return nil, e
	}
	return Object{"state": state, "operationId": operationID, "kind": kind, "result": result, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30, "metadataOnly": true}, nil
}
