package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (s *Service) readTask(ctx context.Context, id string) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.taskWithin(ctx, tx, id, "") })
}
func (s *Service) currentTaskActor(ctx context.Context, id string) (Actor, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) { return s.DutyForTaskWithin(ctx, tx, id, "query") })
}

// RunCodeTask runs only the existing deterministic file-scan/content-restore
// rules. It never requests a model or invents parameters for other effects.
func (s *Service) RunCodeTask(ctx context.Context, input Object) (Object, error) {
	if !closed(input, []string{"taskId"}, nil) || !schemaUUID.MatchString(str(input["taskId"])) {
		return nil, invalid()
	}
	taskID := str(input["taskId"])
	row, e := s.readTask(ctx, taskID)
	if e != nil {
		return nil, e
	}
	if row["mode"] != "code" {
		return nil, fault.New("operations_autonomy_scope_denied", 403)
	}
	response := func(state string) Object {
		status := "ERROR"
		if state == "completed" {
			status = "COMPLETED"
		} else if state == "waiting-human" {
			status = "PAUSED"
		}
		return s.stamp(Object{"taskId": taskID, "operationId": taskID, "nativeRunId": nil, "status": status, "modelState": "not-required", "awaitingHuman": state == "waiting-human", "state": state})
	}
	if has([]string{"completed", "waiting-human", "failed", "stopped"}, str(row["state"])) {
		return response(str(row["state"])), nil
	}
	actor, e := s.currentTaskActor(ctx, taskID)
	if e != nil {
		return nil, e
	}
	cfg := obj(row["configuration"])
	plan := obj(cfg["plan"])
	pinned := obj(cfg["versionBindings"])["strategyVersionId"]
	strategies := []Object{}
	if pinned != nil {
		v, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
			return optional(ctx, tx, `SELECT to_jsonb(v) FROM(SELECT configuration FROM operations_p13_strategy_versions_v1 WHERE endpoint=$1 AND id=$2)v`, s.Endpoint, pinned)
		})
		if e != nil {
			return nil, e
		}
		for _, v := range list(obj(v["configuration"])["strategies"]) {
			r := obj(v)
			if has(texts(plan["strategyIds"]), str(r["id"])) && r["enabled"] == true && r["mode"] == "code-automatic" {
				strategies = append(strategies, r)
			}
		}
	}
	wait := func(code string) (Object, error) {
		_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) { return true, s.WaitForHumanWithin(ctx, tx, taskID, taskID, code) })
		if e != nil {
			return nil, e
		}
		return response("waiting-human"), nil
	}
	if len(strategies) == 0 || s.QueryTool == nil {
		return wait("operations_autonomy_rule_requires_configuration")
	}
	checked, hits := 0, 0
	needsHuman := false
	type target struct {
		id, kind string
		read     Object
	}
	for _, strategy := range strategies {
		actions := texts(obj(strategy["execution"])["actions"])
		if obj(strategy["execution"])["actions"] == nil {
			actions = texts(plan["actions"])
		}
		files := len(actions) == 1 && actions[0] == "files.scan.retry"
		content := strategy["template"] == "selected-public-content-visibility" || len(actions) == 1 && actions[0] == "content.restore"
		if !files && !content {
			needsHuman = true
			continue
		}
		targets := []target{}
		selected := texts(plan["resourceIds"])
		scope := obj(obj(strategy["execution"])["resourceScope"])
		if len(selected) == 0 && scope["kind"] == "selected" {
			selected = texts(scope["resourceIds"])
		}
		if len(selected) > 0 {
			for _, id := range selected {
				kinds := []string{"post", "reply"}
				if files {
					kinds = []string{"chat-file", "forum-file"}
				}
				explicit := map[string]string{"content-reply": "reply", "content-post": "post", "file-chat": "chat-file", "file-forum": "forum-file"}[str(row["target_type"])]
				if explicit != "" {
					kinds = []string{explicit}
				}
				found := false
				for _, kind := range kinds {
					read, e := s.QueryTool(ctx, actor, str(row["domain"]), "read-operation-object", Object{"kind": kind, "id": id, "filters": Object{}})
					if e != nil {
						if fault.Status(e) != 404 {
							return nil, e
						}
						continue
					}
					if read["availability"] == "available" {
						targets = append(targets, target{id, kind, read})
						found = true
						break
					}
				}
				if !found {
					needsHuman = true
				}
			}
		} else if scope["kind"] == "eligible" {
			module := "content"
			filters := Object{"days": "all", "limit": 20}
			if files {
				module = "files"
				filters = Object{"processing": "scan", "limit": 20}
			}
			next := Object{"module": module, "view": "list", "filters": filters}
			seen := map[string]bool{}
			for next != nil {
				if _, e = s.currentTaskActor(ctx, taskID); e != nil {
					return nil, e
				}
				key := jsonText(next)
				if seen[key] {
					needsHuman = true
					break
				}
				seen[key] = true
				page, e := s.QueryTool(ctx, actor, str(row["domain"]), "query-operations", next)
				if e != nil {
					return nil, e
				}
				if page["availability"] != "available" {
					needsHuman = true
					break
				}
				checked++
				for _, v := range list(page["evidenceRefs"]) {
					ref := obj(v)
					kinds := []string{"post", "reply"}
					if files {
						kinds = []string{"chat-file", "forum-file"}
					}
					if has(kinds, str(ref["kind"])) {
						targets = append(targets, target{str(ref["id"]), str(ref["kind"]), nil})
					}
				}
				pagination := obj(page["pagination"])
				if pagination["complete"] == false && pagination["next"] == nil {
					needsHuman = true
					break
				}
				next = obj(pagination["next"])
			}
		} else {
			needsHuman = true
			continue
		}
		for _, target := range targets {
			if _, e = s.currentTaskActor(ctx, taskID); e != nil {
				return nil, e
			}
			read := target.read
			if read == nil {
				read, e = s.QueryTool(ctx, actor, str(row["domain"]), "read-operation-object", Object{"kind": target.kind, "id": target.id, "filters": Object{}})
				if e != nil {
					return nil, e
				}
			}
			if read["availability"] != "available" {
				needsHuman = true
				continue
			}
			checked++
			hit := true
			if strategy["condition"] != nil {
				if !has([]string{"post", "reply"}, target.kind) || s.CurrentPublicSourceWithin == nil {
					needsHuman = true
					continue
				}
				qualified, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.CurrentPublicSourceWithin(ctx, tx, target.kind, target.id) })
				if e != nil {
					return nil, e
				}
				if qualified["available"] != true {
					needsHuman = true
					continue
				}
				kind := "forum-reply"
				if target.kind == "post" {
					kind = "forum-post"
				}
				data := obj(read["data"])
				text := str(data["body"])
				policy := Object{"schema": "business-controls/1", "features": Object{"forumPost": true, "forumReply": true, "chatSend": true, "attachmentUpload": true}, "lists": []any{}, "rules": []any{Object{"id": strategy["id"], "name": "已发布程序规则", "enabled": true, "targets": []any{kind}, "conditions": strategy["condition"], "action": "reject", "exceptions": []any{}}}}
				evaluated, e := businessrules.Evaluate(policy, kind, "", Object{"attachmentCount": len(list(obj(qualified["payload"])["attachments"]))}, &text, list(data["links"]))
				if e != nil {
					return nil, e
				}
				if evaluated.Outcome == "unknown" {
					needsHuman = true
					continue
				}
				hit = has(evaluated.Matched, str(strategy["id"]))
			}
			if !hit || has(texts(cfg["inspectionStrategyIds"]), str(strategy["id"])) {
				continue
			}
			hits++
			var request Object
			if len(actions) == 1 && actions[0] == "files.scan.retry" && has([]string{"chat-file", "forum-file"}, target.kind) {
				targetKind := "forum"
				if target.kind == "chat-file" {
					targetKind = "chat"
				}
				request = Object{"kind": "file-scan-retry", "targetKind": targetKind, "targetId": target.id, "reason": "已批准的程序规则安排扫描重试"}
			}
			if len(actions) == 1 && actions[0] == "content.restore" && has([]string{"post", "reply"}, target.kind) {
				request = Object{"kind": "content-visibility", "targetKind": target.kind, "targetId": target.id, "action": "restore", "reason": "已批准的程序规则复核原自动处置"}
			}
			if request == nil || s.ExecuteDutyOperation == nil {
				needsHuman = true
				continue
			}
			prior, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
				return optional(ctx, tx, `SELECT to_jsonb(c) FROM(SELECT call_id FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 AND tool='execute-operation' AND arguments->>'targetId'=$3 ORDER BY created_at LIMIT 1)c`, s.Endpoint, taskID, target.id)
			})
			if e != nil {
				return nil, e
			}
			callID := str(prior["call_id"])
			if callID == "" {
				callID = uuid.NewString()
			}
			result, e := s.Tool(ctx, Object{"taskId": taskID, "callId": callID, "tool": "execute-operation", "arguments": request}, true)
			if e != nil {
				return nil, e
			}
			if result["state"] == "waiting-human" {
				needsHuman = true
			}
		}
	}
	if needsHuman {
		return wait("operations_autonomy_rule_requires_human")
	}
	if checked == 0 {
		return wait("operations_autonomy_effective_check_required")
	}
	finalState, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (string, error) {
		if _, e := s.DutyForTaskWithin(ctx, tx, taskID, "query"); e != nil {
			return "", e
		}
		if hits == 0 {
			if e := s.RecordBusinessReceiptWithin(ctx, tx, BusinessReceipt{TaskID: taskID, OperationID: taskID, Action: "fixed-rule-check", State: "no-action", Basis: "published-p14-rule-on-current-qualified-source"}); e != nil {
				return "", e
			}
		}
		current, e := s.taskWithin(ctx, tx, taskID, " FOR UPDATE")
		if e != nil {
			return "", e
		}
		current["effective_check"] = true
		completion, e := s.completionWithin(ctx, tx, current, false)
		if e != nil {
			return "", e
		}
		state := str(completion["disposition"])
		if state == "continue" {
			state = "unknown"
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state=$3,model_state='not-required',business_state=$4,effective_check=true,code=$5,lease_until=NULL,completed_at=CASE WHEN $3 IN ('completed','failed') THEN $6 ELSE completed_at END,updated_at=$6,revision=revision+1 WHERE endpoint=$1 AND id=$2`, s.Endpoint, taskID, state, completion["businessState"], completion["reasonCode"], s.now()); e != nil {
			return "", e
		}
		if state == "completed" {
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET last_valid_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["config_id"], s.now()); e != nil {
				return "", e
			}
		}
		return state, nil
	})
	if e != nil {
		return nil, e
	}
	return response(finalState), nil
}
