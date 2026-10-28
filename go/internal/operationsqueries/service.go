// Package operationsqueries owns the fixed AgentOS read tools. Source services
// retain their normal current authorization; arguments never supply an actor.
package operationsqueries

import (
	"context"
	"encoding/json"
	"math"

	"slices"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/maintenance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsresources"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"github.com/agigalaxy-team/agigalaxy/go/internal/systemsettings"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type Service struct {
	Pool            *pgxpool.Pool
	Permissions     *operationspermissions.Service
	Messaging       *messaging.Service
	Accounts        StrategyReader
	Feedback        *feedback.Operations
	Community       *operationscommunity.Service
	Resources       *operationsresources.Service
	Files           *filegovernance.Service
	ChatReports     *chat.ReportService
	Strategies      StrategyReader
	Analytics       StrategyReader
	Recommendations StrategyReader
	Search          StrategyReader
	Runs            StrategyReader
	Jobs            JobReader
	Rules           *operationsrules.Service
	Maintenance     *maintenance.Service
	Audit           *operationsaudit.Service
	Workbench       *Workbench
	RegisteredUsers *registeredusers.Service
	SystemSettings  *systemsettings.Service
	SystemGeneral   *systemsettings.General
	SummaryContext  func(context.Context, Actor, string, Object) (Object, error)
	RecheckContext  func(context.Context, Actor, string, Object) error
	Now             func() time.Time
}
type StrategyReader interface {
	QueryRead(context.Context, Actor, operationspermissions.Authority, string, string, Object) (Object, error)
}
type JobReader interface {
	QueryRead(context.Context, Actor, operationspermissions.Authority, string, Object) (Object, error)
}

func fail(code string, status int) error { return fault.New(code, status) }
func invalid() error                     { return fail("invalid_operations_agentos_query", 400) }
func object(v any) Object                { o, _ := v.(map[string]any); return o }
func str(v any) string                   { s, _ := v.(string); return s }
func exact(o Object, keys ...string) bool {
	if o == nil {
		return false
	}
	for key := range o {
		if !slices.Contains(keys, key) {
			return false
		}
	}
	return true
}
func number(v any) (float64, bool) {
	var n float64
	switch x := v.(type) {
	case int:
		n = float64(x)
	case int64:
		n = float64(x)
	case float64:
		n = x
	case json.Number:
		var e error
		n, e = x.Float64()
		if e != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return n, !math.IsNaN(n) && !math.IsInf(n, 0)
}
func validID(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	id, e := uuid.Parse(s)
	return e == nil && len(s) == 36 && (id == uuid.Nil || id == uuid.Max || id.Version() >= 1 && id.Version() <= 8 && id.Variant() == uuid.RFC4122)
}
func text(v any) any {
	s, _ := utf16Preview(v, 4096)
	return s
}
func shape(fields, kind string) Object {
	o := Object{}
	for _, f := range strings.Fields(fields) {
		o[f] = kind
	}
	return o
}
func merge(all ...Object) Object {
	o := Object{}
	for _, x := range all {
		for k, v := range x {
			o[k] = v
		}
	}
	return o
}
func project(v any, spec any) any {
	if t, ok := spec.(string); ok {
		switch t {
		case "s":
			return text(v)
		case "n":
			if n, ok := number(v); ok && n >= 0 {
				return n
			}
		case "b":
			if b, ok := v.(bool); ok {
				return b
			}
		}
		return nil
	}
	if a, ok := spec.([]any); ok {
		input, ok := v.([]any)
		if !ok {
			return nil
		}
		result := []any{}
		for _, x := range input[:min(100, len(input))] {
			result = append(result, project(x, a[0]))
		}
		return result
	}
	o := object(v)
	out := Object{}
	for k, s := range object(spec) {
		out[k] = project(o[k], s)
	}
	return out
}
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) human(ctx context.Context, a Actor, domain, action string) (Actor, error) {
	if s.Pool == nil || s.Permissions == nil {
		return Actor{}, fail("operations_ai_work_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
		if duty := s.Permissions.Duty; duty != nil && duty.AcceptsDuty(a) {
			metadata, e := duty.DutyMetadata(a)
			if e != nil {
				return Actor{}, e
			}
			if metadata["domain"] != domain {
				return Actor{}, fail("operations_agentos_domain_mismatch", 403)
			}
			fresh, e := duty.RequireDutyAction(ctx, tx, a, "workbench.read", "query")
			if e != nil {
				return Actor{}, e
			}
			return duty.RequireDutyAction(ctx, tx, fresh, action, "query")
		}
		fresh, e := s.Permissions.HumanAIWithin(ctx, tx, a, domain, "query", "workbench.read")
		if e != nil {
			return Actor{}, e
		}
		return s.Permissions.HumanAIWithin(ctx, tx, fresh, domain, "query", action)
	})
}
func (s *Service) reader(a Actor) operationspermissions.Authority {
	if duty := s.Permissions.Duty; duty != nil && duty.AcceptsDuty(a) {
		return &operationspermissions.BusinessAuthority{Duty: duty}
	}
	return s.Permissions.QueryReader()
}

type queryResult struct {
	source, data Object
	refs         []reference
	pagination   Object
	purpose      string
	availability string
}
type reference struct {
	kind, id     string
	row, filters Object
	purpose      string
}
type arguments struct {
	module, view, kind, id string
	filters                Object
}

// Query is the single root integration point; model-facing arguments are a
// closed typed query/read request and never a service name or method name.
func (s *Service) Query(ctx context.Context, actor Actor, domain, tool string, input Object) (Object, error) {
	if !slices.Contains([]string{"overview", "governance", "messaging", "discovery", "maintenance"}, domain) {
		return nil, invalid()
	}
	if tool == "read-ai-delegation" {
		if s.Permissions == nil {
			return nil, fail("operations_query_not_configured", 503)
		}
		return s.Permissions.ReadManagementTool(ctx, actor, domain, input)
	}
	args, e := parse(tool, input)
	if e != nil {
		return nil, e
	}
	action := readAction(args)
	contentPage := tool == "query-operations" && args.module == "content" && args.view == "list"
	var requestedLimit any
	if contentPage {
		requestedLimit = args.filters["limit"]
		args.filters = merge(args.filters)
		limit := 25
		if n, ok := number(requestedLimit); ok {
			limit = int(n)
		}
		args.filters["limit"] = min(limit, 20)
	}
	fresh, e := s.human(ctx, actor, domain, action)
	if e != nil {
		return nil, e
	}
	result, e := s.execute(ctx, fresh, args)
	if e != nil {
		if fault.Code(e) != "operations_query_not_configured" {
			return nil, e
		}
		if _, e = s.human(ctx, fresh, domain, action); e != nil {
			return nil, e
		}
		at := s.now()
		return Object{"tool": tool, "module": args.module, "view": nullable(args.view), "availability": "not-configured", "data": nil, "evidenceRefs": []any{}, "pagination": Object{"next": nil, "complete": nil}, "checkedAt": at, "readExpiresAt": at + 30, "purpose": "operations", "excludedFromProfile": true}, nil
	}
	if _, e = s.human(ctx, fresh, domain, action); e != nil {
		return nil, e
	}
	at := s.now()
	deadline := float64(at + 30)
	if n, ok := number(result.source["readExpiresAt"]); ok {
		deadline = min(deadline, n)
	}
	if deadline <= float64(at) {
		return nil, fail("operations_query_expired", 410)
	}
	refs := []any{}
	readArgs := Object{"module": args.module, "view": args.view, "filters": args.filters}
	if tool == "read-operation-object" {
		readArgs = Object{"kind": args.kind, "id": args.id, "filters": args.filters}
	}
	snapshot := Object{"kind": "operations-query", "id": args.module + ":" + args.view, "version": nil, "label": names[args.module], "href": "/admin/operations/" + locations[args.module], "purpose": "operations", "controlledSource": false, "checkedAt": at, "readExpiresAt": deadline, "read": Object{"tool": tool, "arguments": readArgs}}
	if args.module == "system-settings" && args.view != "overview" {
		snapshot["href"] = "/admin/operations/system-settings?tab=" + args.view
	}
	if args.module == "files" && (strings.HasPrefix(args.view, "cleanup-") || strings.HasPrefix(args.kind, "file-cleanup-")) {
		snapshot["href"] = "/admin/operations/files?kind=all&view=cleanup"
	}
	if tool == "read-operation-object" {
		snapshot["id"] = args.module + ":" + args.kind
	}
	if !slices.Contains([]string{"accounts", "registered-users"}, args.module) || !strings.Contains(str(args.filters["query"]), "@") {
		refs = append(refs, snapshot)
	}
	for _, r := range result.refs {
		ref := s.ref(r, at, deadline)
		if ref != nil {
			refs = append(refs, ref)
			if ref["controlledSource"] == true {
				n, _ := number(ref["readExpiresAt"])
				deadline = min(deadline, n)
			}
		}
	}
	if deadline <= float64(at) {
		return nil, fail("operations_query_expired", 410)
	}
	purpose := result.purpose
	if purpose == "" {
		purpose = "operations"
	}
	pagination := result.pagination
	if pagination == nil {
		pagination = Object{"next": nil, "complete": true}
	}
	value := Object{"tool": tool, "module": args.module, "view": nullable(args.view), "availability": "available", "data": result.data, "evidenceRefs": refs, "pagination": pagination, "checkedAt": at, "readExpiresAt": deadline, "purpose": purpose, "excludedFromProfile": !slices.Contains([]string{"analytics", "recommendations", "search"}, args.module)}
	if contentPage {
		pagination["requestedLimit"], pagination["appliedLimit"] = requestedLimit, args.filters["limit"]
	}
	if result.availability != "" {
		value["availability"] = result.availability
	}
	if value["availability"] != "available" {
		value["evidenceRefs"] = []any{}
	}
	encoded, e := protocol.EncodeJS(value)
	if e != nil {
		return nil, e
	}
	if len(encoded) > 180000 {
		return nil, fail("operations_query_result_too_large", 413)
	}
	return value, nil
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

var names = map[string]string{"accounts": "业务账户", "registered-users": "完整注册目录", "system-settings": "系统设置", "content": "公开内容", "cases": "举报与申诉", "chat-reports": "私聊案件", "feedback": "使用反馈", "files": "文件处理", "resources": "项目与方法", "analytics": "使用分析", "recommendations": "推荐运营", "search": "搜索质量", "messaging": "官方消息", "strategies": "目标与策略", "rules": "业务规则", "maintenance": "系统维护", "audit": "业务审计", "runs": "AI运行记录", "jobs": "运行任务", "permissions": "业务授权"}
var locations = map[string]string{"accounts": "users", "registered-users": "users", "system-settings": "system-settings", "content": "community?tab=posts", "cases": "community?tab=reports", "chat-reports": "chat-reports", "feedback": "feedback", "files": "files", "resources": "resources", "analytics": "analytics", "recommendations": "recommendation", "search": "search-quality", "messaging": "messaging", "strategies": "strategy", "rules": "rules", "maintenance": "maintenance", "audit": "audit", "runs": "ai-runs", "jobs": "jobs", "permissions": "permissions"}

func readAction(a arguments) string {
	if a.module == "accounts" && (a.view == "summary" || a.kind == "account-summary") {
		return "analytics.read"
	}
	if a.module == "content" && (a.view == "sections" || a.kind == "section") {
		return "sections.read"
	}
	if a.module == "content" && a.view == "tags" {
		return "content.tags.read"
	}
	if a.module == "maintenance" && a.view == "logs" {
		return "maintenance.logs.read"
	}
	return map[string]string{"accounts": "accounts.read", "registered-users": "accounts.registered.read", "system-settings": "system.settings.read", "content": "content.read", "cases": "cases.read", "chat-reports": "chat-reports.read", "feedback": "feedback.read", "files": "files.read", "resources": "resources.read", "analytics": "analytics.read", "recommendations": "recommendations.read", "search": "search-quality.read", "messaging": "notices.read", "strategies": "strategies.read", "rules": "rules.read", "maintenance": "maintenance.read", "audit": "audit.read", "runs": "audit.read", "jobs": "jobs.read", "permissions": "permissions.read"}[a.module]
}
