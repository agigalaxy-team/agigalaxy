package actions

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
)

func cleanupPlanKind(kind string) bool {
	return kind == "file-cleanup-plan-create" || kind == "file-cleanup-plan-cancel"
}
func parseCleanupPlanRequest(x Object) (Object, error) {
	if x["kind"] == "file-cleanup-plan-create" {
		if !exact(x, []string{"kind", "items"}, []string{"reason"}) {
			return nil, invalid()
		}
		command := pick(x, "items", "reason")
		command["operationId"] = "00000000-0000-0000-0000-000000000000"
		parsed, e := filegovernance.ParseCleanupCreate(command)
		if e != nil {
			return nil, e
		}
		x["items"], x["reason"] = parsed["items"], parsed["reason"]
		return x, nil
	}
	if x["kind"] != "file-cleanup-plan-cancel" || !exact(x, []string{"kind", "targetId", "expectedRevision"}, nil) || !validID(x["targetId"]) {
		return nil, invalid()
	}
	n, ok := integer(x["expectedRevision"])
	if !ok || n < 1 {
		return nil, invalid()
	}
	return x, nil
}
func (s *Service) prepareCleanupPlan(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.files(a)
	if e != nil {
		return e
	}
	p.impact = []any{}
	p.basis = []any{}
	if x["kind"] == "file-cleanup-plan-create" {
		selected := items(x["items"])
		if len(selected) < 1 || len(selected) > 50 {
			return invalid()
		}
		total := int64(0)
		for i, v := range selected {
			item := obj(v)
			source, e := service.CleanupCandidate(ctx, a, str(item["kind"]), str(item["id"]))
			if e != nil {
				return e
			}
			p.expiry(source["readExpiresAt"])
			candidate := obj(source["candidate"])
			if candidate["id"] != item["id"] || candidate["kind"] != item["kind"] || candidate["expectedVersion"] != item["expectedVersion"] || candidate["eligible"] != true {
				return fail("operations_file_cleanup_plan_changed", 409)
			}
			size, ok := integer(candidate["size"])
			refs, known := integer(candidate["referenceCount"])
			active, activeKnown := integer(candidate["activeReferences"])
			if !ok || !known || !activeKnown || total > 9007199254740991-size {
				return fail("operations_agentos_cleanup_review_required", 409)
			}
			total += size
			p.impact = append(p.impact, fmt.Sprintf("%d. %s · %s · %s · 声明大小 %s 字节 · 资格 %s · 原引用 %d / 活跃引用 %d · 到期 %s", i+1, str(candidate["kind"]), str(candidate["id"]), label(candidate["name"], "未命名文件"), grouped(size), str(candidate["reason"]), refs, active, str(candidate["expiresAt"])))
		}
		p.title = fmt.Sprintf("准备 %d 份文件的清理计划", len(selected))
		p.target = Object{"kind": "file-cleanup-creation", "label": "新清理计划", "href": "/admin/operations/files?kind=all&view=cleanup"}
		p.command = pick(x, "items", "reason")
		p.basis = []any{basis("固定范围", fmt.Sprintf("%d 份文件；声明大小合计 %s 字节", len(selected), grouped(total))), basis("计划理由", coalesce(x["reason"], ""))}
		if str(x["reason"]) == "" {
			p.basis[1] = basis("计划理由", "未填写")
		}
		p.impact = append(p.impact, "只创建等待人工批准的计划；不会删除文件。创建时将重新核查每份文件的状态、版本和引用。")
	} else {
		plan, e := service.CleanupPlan(ctx, a, str(x["targetId"]))
		if e != nil {
			return e
		}
		p.expiry(plan["readExpiresAt"])
		if num(plan["revision"]) != num(x["expectedRevision"]) || obj(plan["permissions"])["canCancel"] != true {
			return fail("operations_file_cleanup_plan_changed", 409)
		}
		rows := items(plan["items"])
		if rows == nil || len(rows) != int(num(plan["itemCount"])) || len(rows) > 50 {
			return fail("operations_agentos_cleanup_review_required", 409)
		}
		p.title = "取消这份文件清理计划"
		p.target = Object{"kind": "file-cleanup-plan", "id": x["targetId"], "label": fmt.Sprintf("具体文件清理计划（%d 份）", len(rows)), "href": "/admin/operations/files?kind=all&view=cleanup&plan=" + str(x["targetId"])}
		p.command = Object{"expectedRevision": x["expectedRevision"]}
		p.basis = []any{basis("当前版本", fmt.Sprint(plan["revision"])), basis("当前状态", str(plan["state"]))}
		p.impact = append(p.impact, "取消只停止后续处理；已移除的服务端文件不会恢复。")
		for i, v := range rows {
			r := obj(v)
			removed := "未确认"
			if value, ok := r["objectRemoved"].(bool); ok {
				if value {
					removed = "已移除"
				} else {
					removed = "未移除"
				}
			}
			p.impact = append(p.impact, fmt.Sprintf("%d. %s · %s · %s · 状态 %s · %s", i+1, str(r["kind"]), str(r["id"]), label(r["name"], "未命名文件"), str(r["state"]), removed))
		}
	}
	totalLength := 0
	for _, v := range p.impact {
		n := jsLength(str(v))
		if n > 5000 {
			return fail("operations_agentos_cleanup_review_required", 409)
		}
		totalLength += n
	}
	if len(p.impact) > 80 || totalLength > 20000 {
		return fail("operations_agentos_cleanup_review_required", 409)
	}
	return nil
}
func normalizeCleanupPlanCommand(x, command, proposal Object) (Object, error) {
	if x["kind"] == "file-cleanup-plan-create" {
		parsed, e := filegovernance.ParseCleanupCreate(command)
		if e != nil || !same(parsed["items"], x["items"]) || !same(parsed["reason"], x["reason"]) || obj(proposal["target"])["kind"] != "file-cleanup-creation" || obj(proposal["target"])["id"] != nil {
			return nil, invalid()
		}
		return parsed, nil
	}
	if !exact(command, []string{"operationId", "expectedRevision"}, nil) || !validID(command["operationId"]) || !same(command["expectedRevision"], x["expectedRevision"]) || obj(proposal["target"])["id"] != x["targetId"] {
		return nil, invalid()
	}
	return command, nil
}
func (s *Service) executeCleanupPlan(ctx context.Context, a Actor, x, command Object) (Object, error) {
	service, e := s.files(a)
	if e != nil {
		return nil, e
	}
	if x["kind"] == "file-cleanup-plan-create" {
		return service.CreateCleanup(ctx, a, command)
	}
	return service.CancelCleanup(ctx, a, str(x["targetId"]), command)
}
func (s *Service) recoverCleanupPlan(ctx context.Context, a Actor, x, command Object) (Object, error) {
	service, e := s.files(a)
	if e != nil {
		return nil, e
	}
	method := "create"
	if x["kind"] == "file-cleanup-plan-cancel" {
		method = "cancel"
	}
	saved, e := service.OriginalCleanupCommand(ctx, a, method, str(x["targetId"]), command)
	if e != nil {
		return nil, e
	}
	if saved["state"] == "not-recorded" {
		return nil, nil
	}
	if saved["state"] != "recorded" {
		return unknown(str(command["operationId"])), nil
	}
	current, e := service.CleanupOperation(ctx, a, str(command["operationId"]))
	if e != nil {
		return nil, e
	}
	if current["state"] != "recorded" || current["kind"] != method || current["planId"] != saved["planId"] {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	plan, e := service.CleanupPlan(ctx, a, str(saved["planId"]))
	if e != nil {
		return nil, e
	}
	if plan["id"] != saved["planId"] {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	return Object{"operationId": command["operationId"], "planId": saved["planId"], "kind": method, "state": map[string]string{"create": "awaiting-approval", "cancel": "cancelled"}[method], "replayed": true}, nil
}
func cleanupPlanResult(kind string, result Object, operationID string, x Object) (Object, error) {
	if result["state"] == "unknown" {
		return unknown(operationID), nil
	}
	expectedMethod, expectedState := "create", "awaiting-approval"
	if kind == "file-cleanup-plan-cancel" {
		expectedMethod, expectedState = "cancel", "cancelled"
	}
	if result["operationId"] != operationID || !validID(result["planId"]) || result["kind"] != expectedMethod || result["state"] != expectedState || expectedMethod == "cancel" && result["planId"] != x["targetId"] {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	summary := "清理计划已创建；创建时等待人工批准，当前执行情况以计划记录为准。"
	if expectedMethod == "cancel" {
		summary = "清理计划已取消；已移除的文件不会恢复。"
	}
	return Object{"operationId": operationID, "state": "completed", "summary": summary, "receipt": Object{"planId": result["planId"], "stateAtOperation": expectedState, "replayed": result["replayed"] == true}}, nil
}
