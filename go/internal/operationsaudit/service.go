package operationsaudit

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type Actor = operationspermissions.Actor
type Service struct {
	Domain  *businessadmin.Domain
	mu      sync.Mutex
	entries map[string]*snapshot
	closed  bool
}

func (s *Service) now() int64 {
	if s.Domain.Now != nil {
		return s.Domain.Now().Unix()
	}
	return time.Now().Unix()
}

var readActions = strings.Fields("ai-prompt-read users-query user-read audit-read chat-reports-query chat-report-read chat-report-attachment operations-summary-read community-posts-query community-post-read community-sections-query community-section-read community-reports-query community-report-read resources-query resource-read files-query file-read feedback-query feedback-read community-content-query community-content-read community-content-batch-preview community-tags-query maintenance-query maintenance-logs-query file-cleanup-read file-access-read smtp-query smtp-dns-check")

func actionCodes() []string {
	result := []string{}
	for action := range catalog.Actions {
		result = append(result, action)
	}
	slices.Sort(result)
	return result
}
func kindActions(kind string) any {
	if kind == "reads" {
		return readActions
	}
	if kind == "business" {
		result := []string{}
		for _, action := range actionCodes() {
			if !slices.Contains(readActions, action) {
				result = append(result, action)
			}
		}
		return result
	}
	return nil
}
func rows(ctx context.Context, db interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, sql string, args ...any) ([]Object, error) {
	result, e := db.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer result.Close()
	out := []Object{}
	for result.Next() {
		var raw []byte
		if e = result.Scan(&raw); e != nil {
			return nil, e
		}
		var row Object
		if e = decode(raw, &row); e != nil {
			return nil, e
		}
		out = append(out, row)
	}
	return out, result.Err()
}
func decode(raw []byte, target any) error { return protocol.Decode(raw, target) }
func stringValue(v any) string            { return fmt.Sprint(v) }
func (s *Service) fresh(ctx context.Context, d *businessadmin.Domain, a Actor) (Actor, error) {
	return postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (Actor, error) { return d.Fresh(ctx, tx, a, "audit.read") })
}
func (s *Service) Audit(ctx context.Context, a Actor, input Object) (Object, error) {
	return s.audit(ctx, s.Domain, a, input)
}

// AuditWithAuthority reuses the same actual ledger/cache through the owning
// query proof reader; authority is a trusted Go dependency, never JSON input.
func (s *Service) AuditWithAuthority(ctx context.Context, a Actor, input Object, authority operationspermissions.Authority) (Object, error) {
	if s.Domain == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	d := &businessadmin.Domain{Pool: s.Domain.Pool, Endpoint: s.Domain.Endpoint, Authority: authority, Duty: s.Domain.Duty, Now: s.Domain.Now}
	return s.audit(ctx, d, a, input)
}
func (s *Service) audit(ctx context.Context, d *businessadmin.Domain, a Actor, input Object) (Object, error) {
	if d == nil || d.Pool == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	actor, e := s.fresh(ctx, d, a)
	if e != nil {
		return nil, e
	}
	q, e := Parse(input)
	if e != nil {
		return nil, e
	}
	for _, key := range []string{"page", "pageSize", "snapshot", "sort"} {
		if _, present := q[key]; present {
			return s.pageAudit(ctx, d, actor, q)
		}
	}
	limit := 30
	if n, ok := q["limit"].(int); ok {
		limit = n
	}
	q["limit"] = limit
	if action := str(q["action"]); action != "" && catalog.Actions[action] == nil {
		return nil, invalid()
	}
	actions, e := s.actions(ctx)
	if e != nil {
		return nil, e
	}
	projecting := q["resourceId"] != nil || str(q["query"]) != ""
	maximum := limit
	if projecting {
		maximum = 500
	}
	found, e := rows(ctx, d.Pool, `SELECT to_jsonb(a)||jsonb_build_object('operator_display_name',NULLIF(BTRIM(p.display_name),'')) FROM business_admin_audit_v1 a LEFT JOIN operations_operator_principals_v1 p ON p.operator_id=a.operator_id AND p.endpoint=a.endpoint AND a.actor_kind='business-operator' WHERE a.endpoint=$1 AND ($2::uuid IS NULL OR a.account_id=$2) AND ($3::bigint IS NULL OR a.sequence<$3) AND ($5::text IS NULL OR a.action=$5) AND ($6::text[] IS NULL OR a.action=ANY($6)) AND ($7::date IS NULL OR (a.created_at>=($7::date::timestamp AT TIME ZONE 'Asia/Shanghai') AND a.created_at<(($7::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) ORDER BY a.sequence DESC LIMIT $4`, d.Endpoint, q["accountId"], q["after"], maximum+1, q["action"], kindActions(str(q["kind"])), q["day"])
	if e != nil {
		return nil, e
	}
	found, e = s.decorate(ctx, found, slices.Contains(actor.Permissions, "autonomy.read"))
	if e != nil {
		return nil, e
	}
	matches := []any{}
	inspected := 0
	scan := len(found)
	if projecting {
		scan = min(scan, maximum)
	}
	for _, row := range found[:scan] {
		inspected++
		item := Metadata(row)
		if !matchesQuery(item, q, false) {
			continue
		}
		matches = append(matches, item)
		if len(matches) > limit {
			break
		}
	}
	limited := projecting && len(matches) <= limit && len(found) > maximum
	var next any
	if len(matches) > limit {
		matches = matches[:limit]
		next = obj(matches[len(matches)-1])["sequence"]
	} else if limited {
		next = stringValue(found[inspected-1]["sequence"])
	}
	selection := Object{"resourceId": q["resourceId"], "after": q["after"], "limit": limit, "kind": q["kind"], "action": q["action"], "day": q["day"], "hasQuery": str(q["query"]) != ""}
	if e = s.record(ctx, d, actor, q["accountId"], selection, len(matches)); e != nil {
		return nil, e
	}
	return Object{"items": matches, "nextAfter": next, "checkedAt": s.now(), "metadataOnly": true, "actions": actions, "scanLimited": limited}, nil
}
func (s *Service) record(ctx context.Context, d *businessadmin.Domain, a Actor, accountID any, selection Object, count int) error {
	_, e := postgres.InTx(ctx, d.Pool, func(tx pgx.Tx) (struct{}, error) {
		fresh, e := d.Fresh(ctx, tx, a, "audit.read")
		if e != nil {
			return struct{}{}, e
		}
		return struct{}{}, d.RecordAccountRead(ctx, tx, fresh, "audit-read", selection, Object{"count": count}, accountID)
	})
	return e
}
func (s *Service) actions(ctx context.Context) ([]string, error) {
	r, e := s.Domain.Pool.Query(ctx, "SELECT DISTINCT action FROM business_admin_audit_v1 WHERE endpoint=$1 AND action=ANY($2::text[]) ORDER BY action", s.Domain.Endpoint, actionCodes())
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []string{}
	for r.Next() {
		var action string
		if e = r.Scan(&action); e != nil {
			return nil, e
		}
		out = append(out, action)
	}
	return out, r.Err()
}
