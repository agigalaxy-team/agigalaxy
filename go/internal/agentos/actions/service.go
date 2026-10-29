// Package actions connects the original prepared operation cards and durable
// duties to the owning business services. It does not mint a new identity.
package actions

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsjobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsresources"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"math"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"
)

type Object = map[string]any
type Actor = operationspermissions.Actor
type Authorize = func(context.Context, pgx.Tx) (Actor, error)
type Service struct {
	Pool              *pgxpool.Pool
	Endpoint          string
	Permissions       *operationspermissions.Service
	Autonomy          *operationsautonomy.Service
	Content           *operationscommunity.Service
	Files             *filegovernance.Service
	Resources         *operationsresources.Service
	ChatReports       *chat.ReportService
	AccountGovernance *operationsaccounts.Service
	Messaging         *messaging.Service
	Feedback          *feedback.Operations
	Jobs              *operationsjobs.Service
	Strategies        *operationsstrategies.Service
	Rules             *operationsrules.Service
	SearchQuality     *discovery.SearchQuality
	Recommendations   *discovery.Recommendations
	Now               func() time.Time
}

func fail(code string, status int) error { return fault.New(code, status) }
func invalid() error                     { return fail("invalid_operations_agentos_action", 400) }
func obj(v any) Object                   { o, _ := v.(map[string]any); return o }
func str(v any) string                   { s, _ := v.(string); return s }
func integer(v any) (int64, bool) {
	var f float64
	switch n := v.(type) {
	case int:
		return int64(n), n >= 0 && int64(n) <= 9007199254740991
	case int64:
		return n, n >= 0 && n <= 9007199254740991
	case float64:
		f = n
	case json.Number:
		var e error
		f, e = n.Float64()
		if e != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return int64(f), !math.IsNaN(f) && !math.IsInf(f, 0) && f >= 0 && f <= 9007199254740991 && math.Trunc(f) == f
}
func num(v any) int64 { n, _ := integer(v); return n }
func items(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	if a, ok := v.([]Object); ok {
		out := []any{}
		for _, v := range a {
			out = append(out, v)
		}
		return out
	}
	return nil
}
func clone(o Object) Object {
	v := Object{}
	for k, x := range o {
		v[k] = x
	}
	return v
}
func pick(o Object, keys ...string) Object {
	out := Object{}
	for _, k := range keys {
		if v, ok := o[k]; ok {
			out[k] = v
		}
	}
	return out
}
func same(a, b any) bool {
	x, e := identity.Canonical([]any{a})
	y, f := identity.Canonical([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func wire(o Object) (Object, error) {
	raw, e := protocol.Encode(o)
	if e != nil {
		return nil, e
	}
	var out Object
	e = protocol.Decode(raw, &out)
	return out, e
}
func trim(v string) string {
	return strings.TrimFunc(v, func(r rune) bool { return r == '\ufeff' || unicode.IsSpace(r) && r != 0x85 })
}
func jsLength(v string) int { return len(utf16.Encode([]rune(v))) }
func label(v any, fallback string) string {
	s := str(v)
	if trim(s) == "" {
		return fallback
	}
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, s)
	units := utf16.Encode([]rune(trim(s)))
	if len(units) > 180 {
		units = units[:180]
	}
	return string(utf16.Decode(units))
}
func (s *Service) now() int64 {
	if s.Now != nil {
		return s.Now().Unix()
	}
	return time.Now().Unix()
}
func (s *Service) isDuty(a Actor) bool {
	return s.Permissions != nil && s.Permissions.Duty != nil && s.Permissions.Duty.AcceptsDuty(a)
}

var cardReadOnce sync.Once
var cardReads map[string]string

func CardReadPermission(kind string) (string, error) {
	if cleanupPlanKind(kind) {
		return "files.read", nil
	}
	if contentTagKind(kind) {
		return "content.tags.read", nil
	}
	if kind == "notice-draft-create" || kind == "notice-draft-save" || kind == "notice-state" {
		return "notices.read", nil
	}
	if kind == "recommendation-policy-save" || kind == "recommendation-theme-update" {
		return "recommendations.read", nil
	}
	if kind == "strategy-rehearsal" || kind == "ordinary-strategy-create-draft" {
		return "strategies.read", nil
	}
	cardReadOnce.Do(func() {
		cardReads = map[string]string{}
		for _, code := range operationspermissions.PermissionCodes() {
			definition := operationsai.Definition(code)
			if kind, read := str(definition["kind"]), str(definition["read"]); kind != "" && read != "" {
				cardReads[kind] = read
			}
		}
	})
	if read := cardReads[kind]; read != "" {
		return read, nil
	}
	return "", fail("operations_agentos_action_not_connected", 503)
}
func (s *Service) human(ctx context.Context, a Actor, domain, permission, purpose string, authorize Authorize) (Actor, error) {
	if s.Pool == nil || s.Permissions == nil {
		return Actor{}, fail("operations_authorization_unavailable", 503)
	}
	if authorize != nil {
		fresh, e := authorize(ctx, nil)
		if e != nil {
			return Actor{}, e
		}
		if fresh.ID != a.ID || fresh.Endpoint != s.Endpoint {
			return Actor{}, fail("business_admin_denied", 403)
		}
		a = fresh
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
		if s.isDuty(a) {
			metadata, e := s.Permissions.Duty.DutyMetadata(a)
			if e != nil {
				return Actor{}, e
			}
			if metadata["domain"] != domain {
				return Actor{}, fail("operations_agentos_domain_mismatch", 403)
			}
			return s.Permissions.Duty.RequireDutyAction(ctx, tx, a, permission, purpose)
		}
		return s.Permissions.HumanAIWithin(ctx, tx, a, domain, purpose, permission)
	})
}
func (s *Service) authority(a Actor) operationspermissions.Authority {
	var human operationspermissions.Authority = s.Permissions.PreparationReader()
	if context, e := s.Permissions.AIWorkContext(a); e == nil && context["purpose"] == "query" {
		human = s.Permissions.QueryReader()
	}
	var execution operationspermissions.ExecutionAuthority
	if s.Content != nil {
		if live, ok := s.Content.Authority.(*operationspermissions.BusinessAuthority); ok {
			execution = live.Execution
		}
	}
	return &operationspermissions.BusinessAuthority{Human: human, Duty: s.Permissions.Duty, Execution: execution}
}
func (s *Service) content(a Actor) (*operationscommunity.Service, error) {
	if s.Content == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	v := s.Content
	return &operationscommunity.Service{Pool: v.Pool, Endpoint: v.Endpoint, Authority: s.authority(a), Duty: v.Duty, PrincipalWithin: v.PrincipalWithin, ReadPrincipalWithin: v.ReadPrincipalWithin, Forum: v.Forum, Files: v.Files, Links: v.Links, Now: v.Now}, nil
}
func (s *Service) files(a Actor) (*filegovernance.Service, error) {
	if s.Files == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	v := s.Files
	return &filegovernance.Service{Pool: v.Pool, Endpoint: v.Endpoint, Authority: s.authority(a), Duty: v.Duty, StoredAuthority: v.StoredAuthority, PrincipalWithin: v.PrincipalWithin, Chat: v.Chat, Forum: v.Forum, Now: v.Now, Diagnostic: v.Diagnostic}, nil
}

func (s *Service) resources(a Actor) (*operationsresources.Service, error) {
	if s.Resources == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	v := s.Resources
	return &operationsresources.Service{Pool: v.Pool, Endpoint: v.Endpoint, Authority: s.authority(a), Duty: v.Duty, PrincipalWithin: v.PrincipalWithin, Projects: v.Projects, Capsules: v.Capsules, MaxHideSeconds: v.MaxHideSeconds, MaxHideSecondsNow: v.MaxHideSecondsNow, Now: v.Now}, nil
}
func (s *Service) chatReports(a Actor) (*chat.ReportService, error) {
	if s.ChatReports == nil || s.ChatReports.Admin == nil {
		return nil, fail("operations_agentos_action_not_connected", 503)
	}
	v := s.ChatReports
	d := *v.Admin
	d.Authority, d.Duty = s.authority(a), s.Permissions.Duty
	return &chat.ReportService{Chat: v.Chat, Attachments: v.Attachments, Admin: &d, ReadPrincipalWithin: v.ReadPrincipalWithin, NamesWithin: v.NamesWithin}, nil
}
func required(x Object) string {
	switch str(x["kind"]) {
	case "strategy-draft":
		return "strategies.configure"
	case "strategy-rehearsal":
		return "strategies.read"
	case "strategy-publish":
		return "strategies.publish"
	case "ordinary-strategy-draft", "ordinary-strategy-create-draft":
		return "strategies.ordinary.configure"
	case "ordinary-strategy-publish":
		return "strategies.ordinary.publish"
	case "strategy-control":
		return "strategies.control"
	case "strategy-continue":
		return "strategies.run"
	case "rule-publish", "rule-restore":
		return "rules.write"
	case "search-apply":
		return "search-quality.publish"
	case "search-draft-save":
		return "search-quality.configure"
	case "search-restore":
		return "search-quality.restore"
	case "recommendation-direction", "recommendation-policy-save", "recommendation-theme-update":
		return "recommendations.configure"
	case "job-cancel":
		return "jobs.cancel"
	case "job-retry":
		return "jobs.retry"
	case "search-retry":
		return "search.retry"
	case "content-visibility":
		return "content." + str(x["action"])
	case "content-curation":
		return "content.curate"
	case "content-tag-create", "content-tag-update":
		return "content.tags.manage"
	case "public-content-batch":
		return "content.batch." + str(x["action"])
	case "file-scan-retry":
		return "files.scan.retry"
	case "file-access":
		return "files.access." + str(x["action"])
	case "file-cleanup-approve":
		return "files.cleanup.approve"
	case "file-cleanup-plan-create", "file-cleanup-plan-cancel":
		return "files.cleanup.plan"
	case "section-classification":
		return "sections.classify"
	case "section-visibility":
		return "sections." + str(x["action"])
	case "resource-visibility":
		return "resources." + str(x["action"])
	case "case-resolve":
		return "cases.resolve"
	case "private-case-message":
		return "chat-messages." + str(x["action"])
	case "account-restriction":
		return "accounts.restriction." + str(x["action"])
	case "message-draft-create", "notice-draft-create":
		return "notices.create"
	case "message-draft-save", "notice-draft-save":
		return "notices.update"
	case "feedback-update":
		return "feedback.update"
	case "notice-state":
		if x["action"] == "publish" {
			return "notices.publish"
		}
		return "notices.withdraw"
	case "messaging-state":
		if x["action"] == "activate" || x["action"] == "resume" {
			return "notices.publish"
		}
		return "notices.withdraw"
	}
	return ""
}
func (s *Service) ActionReady(permission string) bool {
	definition := operationsai.Definition(permission)
	if definition["query"] == true {
		return true
	}
	if definition["autonomous"] != true {
		return false
	}
	switch str(definition["kind"]) {
	case "ordinary-strategy-draft", "ordinary-strategy-publish", "strategy-control", "strategy-continue":
		return s.Strategies != nil
	case "rule-publish", "rule-restore":
		return s.Rules != nil
	case "search-draft-save", "search-apply", "search-restore":
		return s.SearchQuality != nil
	case "recommendation-direction":
		return s.Recommendations != nil
	case "job-cancel", "job-retry", "search-retry":
		return s.Jobs != nil
	case "content-visibility", "content-curation", "public-content-batch":
		return s.Content != nil
	case "file-scan-retry", "file-access":
		return s.Files != nil
	case "section-classification", "section-visibility", "case-resolve":
		return s.Content != nil
	case "resource-visibility":
		return s.Resources != nil
	case "private-case-message":
		return s.ChatReports != nil
	case "account-restriction":
		return s.AccountGovernance != nil
	case "message-draft-create", "message-draft-save", "messaging-state":
		return s.Messaging != nil
	case "feedback-update":
		return s.Feedback != nil
	}
	return false
}
func category(v string) string {
	return map[string]string{"technology": "科技", "arts": "艺术", "learning": "学习", "life": "生活", "galaxy": "银河", "unclassified": "未分类"}[v]
}
func capability(value any) error {
	if value != true {
		return fail("operations_agentos_operation_unavailable", 409)
	}
	return nil
}
func restrictedTime(seconds int64) string {
	return time.Unix(seconds, 0).In(time.FixedZone("Asia/Shanghai", 8*3600)).Format("2006/01/02 15:04:05")
}
