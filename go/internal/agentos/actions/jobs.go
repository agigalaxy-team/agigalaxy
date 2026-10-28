package actions

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsjobs"
	"slices"
)

func (s *Service) jobActions(a Actor) (*operationsjobs.Service, error) {
	if s.Jobs == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	v := s.Jobs
	return &operationsjobs.Service{Pool: v.Pool, Endpoint: v.Endpoint, Authority: s.authority(a), Duty: s.Permissions.Duty, Now: v.Now, Queue: v.Queue, Watches: v.Watches, Retention: v.Retention, ReadJobWithin: v.ReadJobWithin, ListJobs: v.ListJobs, Search: v.Search, SearchQualifyWithin: v.SearchQualifyWithin, Cancellations: v.Cancellations}, nil
}
func (s *Service) prepareJobs(ctx context.Context, a Actor, x Object, p *preparation) error {
	service, e := s.jobActions(a)
	if e != nil {
		return e
	}
	kind := str(x["kind"])
	job, e := service.Read(ctx, a, kind, x)
	if e != nil {
		return e
	}
	search := kind == "search-retry"
	if search {
		if e = capability(job["state"] == "failed"); e != nil {
			return e
		}
		p.command = Object{"expectedGeneration": job["generation"], "reason": x["reason"]}
	} else {
		allowed := job["state"] == "failed"
		if kind == "job-cancel" {
			allowed = slices.Contains([]string{"created", "retry", "active", "cancelled"}, str(job["state"]))
		}
		if e = capability(allowed); e != nil {
			return e
		}
		p.command = Object{"expectedState": job["state"], "expectedRetryCount": job["retryCount"], "reason": x["reason"]}
	}
	targetKind, display := "queue-job", str(x["queue"])+" 队列中的具体任务"
	basisLabel, basisValue := "队列", x["queue"]
	if search {
		targetKind = "search-job"
		display = fmt.Sprintf("失败索引任务的第 %d 代", num(job["generation"]))
		basisLabel, basisValue = "索引代数", fmt.Sprintf("%d", num(job["generation"]))
	}
	p.target = Object{"kind": targetKind, "id": x["targetId"], "label": display, "href": "/admin/operations/jobs"}
	p.title = "重新安排这项失败任务"
	impact := "仅重新安排所选失败任务，不表示索引或业务已经执行成功。"
	if kind == "job-cancel" {
		p.title = "取消这项运行任务"
		impact = "停止这项队列工作；已完成的外部效果不会撤回。"
	}
	p.basis = []any{basis("任务 ID", x["targetId"]), basis(basisLabel, basisValue), basis("当前状态", job["state"])}
	p.impact = []any{impact, "执行前重新检查任务状态及所属业务权限。"}
	return nil
}
func jobsResult(kind string, result Object, operation string, request, command Object) (Object, error) {
	if result["jobId"] != request["targetId"] {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	if _, ok := result["state"].(string); !ok {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	if kind == "search-retry" {
		if !same(result["generation"], command["expectedGeneration"]) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
	} else if result["queue"] != request["queue"] {
		return nil, fail("operations_agentos_operation_conflict", 409)
	}
	receipt := Object{"operationId": operation}
	for k, v := range result {
		receipt[k] = v
	}
	summary := "已重新安排原失败任务；实际执行结果仍需读取。"
	if kind == "job-cancel" {
		summary = "这次任务取消已记录。"
	}
	return Object{"operationId": operation, "state": "completed", "summary": summary, "receipt": receipt}, nil
}
