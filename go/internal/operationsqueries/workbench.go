package operationsqueries

import (
	"context"
	"slices"

	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type Workbench struct {
	Domain            *businessadmin.Domain
	Forum             *community.Service
	QueueSummary      func(context.Context, pgx.Tx, string) (Object, error)
	FileSummaryWithin func(context.Context, pgx.Tx) (Object, error)
	// The actual autonomy owner supplies a purpose-preserving read adapter.
	AutonomySummary func(context.Context, Actor, operationspermissions.Authority) (Object, error)
}

// WorkbenchSummary is the conversations' real source callback. The domain and
// purpose come from the existing private proof, never from summary arguments.
func (s *Service) WorkbenchSummary(ctx context.Context, a Actor) (Object, error) {
	if s.Workbench == nil || s.Permissions == nil {
		return nil, fail("operations_query_not_configured", 503)
	}
	var scope Object
	var e error
	if duty := s.Permissions.Duty; duty != nil && duty.AcceptsDuty(a) {
		scope, e = duty.DutyMetadata(a)
	} else {
		scope, e = s.Permissions.AIWorkContext(a)
		if e == nil && scope["purpose"] != "query" {
			return nil, fail("operations_agentos_scope_denied", 403)
		}
	}
	if e != nil {
		return nil, e
	}
	domain := str(scope["domain"])
	fresh, e := s.human(ctx, a, domain, "workbench.read")
	if e != nil {
		return nil, e
	}
	result, e := s.Workbench.SummaryWithAuthority(ctx, fresh, Object{"publicActivity": "deferred"}, s.reader(fresh))
	if e != nil {
		return nil, e
	}
	if _, e = s.human(ctx, fresh, domain, "workbench.read"); e != nil {
		return nil, e
	}
	return result, nil
}

func (b *Workbench) now() int64 {
	if b.Domain.Now != nil {
		return b.Domain.Now().Unix()
	}
	return time.Now().Unix()
}
func sqlRows(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]Object, error) {
	r, e := tx.Query(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	defer r.Close()
	out := []Object{}
	for r.Next() {
		var raw []byte
		if e = r.Scan(&raw); e != nil {
			return nil, e
		}
		var row Object
		if e = protocol.Decode(raw, &row); e != nil {
			return nil, e
		}
		out = append(out, row)
	}
	return out, r.Err()
}
func (b *Workbench) Summary(ctx context.Context, a Actor, options Object) (Object, error) {
	return b.summary(ctx, b.Domain, a, options)
}
func (b *Workbench) SummaryWithAuthority(ctx context.Context, a Actor, options Object, authority operationspermissions.Authority) (Object, error) {
	if b.Domain == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	d := *b.Domain
	d.Authority = authority
	return b.summary(ctx, &d, a, options)
}
func (b *Workbench) summary(ctx context.Context, d *businessadmin.Domain, a Actor, options Object) (Object, error) {
	if d == nil || d.Pool == nil {
		return nil, fail("operations_query_not_configured", 503)
	}
	if options == nil {
		options = Object{}
	}
	if !exact(options, "publicActivity") {
		return nil, fail("invalid_operations_request", 400)
	}
	if v, present := options["publicActivity"]; present && v != "deferred" {
		return nil, fail("invalid_operations_request", 400)
	}
	current := *d
	current.Permissions = func(action string, _ Object) []string {
		if action == "operations-summary-read" {
			return []string{"workbench.read"}
		}
		return nil
	}
	var fresh Actor
	snapshot, e := current.Run(ctx, a, "operations-summary-read", Object{}, func(tx pgx.Tx, actor Actor) (Object, error) {
		fresh = actor
		availability := Object{}
		read := func(key, permission, query string, args ...any) (Object, error) {
			if !slices.Contains(actor.Permissions, permission) {
				availability[key] = "not-authorized"
				return nil, nil
			}
			availability[key] = "available"
			r, e := sqlRows(ctx, tx, "SELECT to_jsonb(r) FROM ("+query+") r", args...)
			if e != nil {
				return nil, e
			}
			if len(r) == 0 {
				return nil, nil
			}
			return r[0], nil
		}
		reports, e := read("communityReports", "cases.read", "SELECT count(*) FILTER(WHERE state IN ('pending','appealed'))::integer AS pending,count(*)::integer AS total FROM forum_reports_v1")
		if e != nil {
			return nil, e
		}
		chat, e := read("chatReports", "chat-reports.read", "SELECT count(*) FILTER(WHERE state IN ('received','reviewing','appealed'))::integer AS pending,count(*)::integer AS total FROM account_chat_reports_v1 WHERE endpoint=$1", d.Endpoint)
		if e != nil {
			return nil, e
		}
		sections, e := read("sections", "sections.read", "SELECT count(*) FILTER(WHERE state='active')::integer AS active,count(*) FILTER(WHERE state='archived')::integer AS archived FROM forum_sections_v2")
		if e != nil {
			return nil, e
		}
		resources, e := read("resources", "resources.read", "SELECT (SELECT count(*)::integer FROM projects_v2 WHERE state='active') AS projects,(SELECT count(*)::integer FROM capsules WHERE revision>0) AS methods")
		if e != nil {
			return nil, e
		}
		var files Object
		availability["files"] = "not-authorized"
		if slices.Contains(actor.Permissions, "files.read") {
			availability["files"] = "unavailable"
			if b.FileSummaryWithin != nil {
				files, e = b.FileSummaryWithin(ctx, tx)
				if e != nil {
					return nil, e
				}
				availability["files"] = "available"
			}
		}
		var jobs Object
		availability["jobs"] = "not-authorized"
		if slices.Contains(actor.Permissions, "jobs.read") {
			availability["jobs"] = "unavailable"
			if b.QueueSummary != nil {
				jobs, e = b.QueueSummary(ctx, tx, d.Endpoint)
				if e != nil {
					if !slices.Contains([]string{"operations_job_backend_not_adopted", "operations_job_backend_unavailable"}, fault.Code(e)) {
						return nil, e
					}
					jobs = nil
				} else {
					availability["jobs"] = "available"
				}
			}
		}
		feedback, e := read("feedback", "feedback.read", "SELECT count(*)::integer AS total,count(*) FILTER(WHERE state='pending')::integer AS pending,count(*) FILTER(WHERE state='processing')::integer AS processing,count(*) FILTER(WHERE category IS NULL)::integer AS unclassified FROM operations_feedback_v1 WHERE endpoint=$1 AND owner_deleted_at IS NULL", d.Endpoint)
		if e != nil {
			return nil, e
		}
		search, e := read("search", "search.read", "SELECT count(*)::integer AS failed FROM jobs WHERE kind='search-index' AND state='failed'")
		if e != nil {
			return nil, e
		}
		var activity Object
		availability["businessActivity"] = "not-authorized"
		if slices.Contains(actor.Permissions, "content.read") {
			if options["publicActivity"] == "deferred" {
				availability["businessActivity"] = "not-requested"
			} else {
				availability["businessActivity"] = "available"
				activity, e = b.publicActivity(ctx, tx, b.now())
				if e != nil {
					return nil, e
				}
			}
		}
		var recent any
		availability["recentOperations"] = "not-authorized"
		if slices.Contains(actor.Permissions, "audit.read") {
			availability["recentOperations"] = "available"
			all, e := sqlRows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT id,action,operator_id,account_id,created_at,COALESCE(selection->>'resourceId',selection->>'id',selection->>'sectionId',selection->>'reportId',selection->>'projectId',selection->>'methodId',selection->>'fileId',selection->>'noticeId',selection->>'runId',selection->>'jobId') AS resource_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id IS NOT NULL ORDER BY sequence DESC LIMIT 12) r`, d.Endpoint)
			if e != nil {
				return nil, e
			}
			out := []any{}
			for _, row := range all {
				out = append(out, Object{"id": row["id"], "action": row["action"], "operatorId": row["operator_id"], "accountId": row["account_id"], "resourceId": row["resource_id"], "createdAt": stamp(row["created_at"])})
			}
			recent = out
		}
		var fileStats any
		if files != nil {
			fileStats = Object{"scanPending": files["scan_pending"], "scanFailed": files["scan_failed"], "cleanupPending": files["cleanup_pending"], "cleanupFailed": nil, "cleanupResultUnknown": files["cleanup_unknown"]}
		}
		return Object{"communityReports": reports, "chatReports": chat, "sections": sections, "resources": resources, "files": fileStats, "jobs": jobs, "search": search, "feedback": feedback, "availability": availability, "operator": Object{"id": actor.ID, "role": actor.Role, "businessAuthorization": Object{"version": actor.Version, "permissions": actor.Permissions}}, "analytics": Object{"available": false, "state": "not-collected", "reason": "usage-events-not-collected", "visitors": nil, "pageViews": nil, "activeAccounts": nil, "returnRate": nil, "dailyActivity": []any{}, "retention": []any{}}, "businessActivity": activity, "recentOperations": recent, "ai": nil, "autonomy": nil, "checkedAt": b.now(), "readExpiresAt": b.now() + 30}, nil
	}, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	availability := object(snapshot["availability"])
	if !slices.Contains(fresh.Permissions, "autonomy.read") {
		availability["ai"] = "not-authorized"
		return snapshot, nil
	}
	if b.AutonomySummary == nil {
		availability["ai"] = "unavailable"
		return snapshot, nil
	}
	autonomy, e := b.AutonomySummary(ctx, fresh, d.Authority)
	if e != nil {
		availability["ai"] = "unavailable"
		if fault.Status(e) == 403 {
			availability["ai"] = "not-authorized"
		}
		return snapshot, nil
	}
	snapshot["autonomy"] = autonomy
	availability["ai"] = "available"
	progress := []any{}
	tasks := anyArray(autonomy["recentTasks"])
	for _, v := range tasks {
		task := object(v)
		if slices.Contains([]string{"awaiting-human", "waiting-human", "failed", "unknown"}, str(task["state"])) {
			continue
		}
		progress = append(progress, Object{"id": task["id"], "label": task["title"], "createdAt": task["updatedAt"], "href": "/admin/operations/ai-runs?task=" + str(task["id"]), "source": "自动运行"})
		if len(progress) == 3 {
			break
		}
	}
	state := object(autonomy["runtime"])["state"]
	if state == nil {
		state = "unavailable"
	}
	snapshot["ai"] = Object{"state": state, "logs": tasks, "recentProgress": progress}
	if n, ok := number(autonomy["readExpiresAt"]); ok {
		snapshot["readExpiresAt"] = min(float64(b.now()+30), n)
	}
	return snapshot, nil
}
func anyArray(v any) []any {
	if a, ok := v.([]any); ok {
		return a
	}
	out := []any{}
	if a, ok := v.([]Object); ok {
		for _, row := range a {
			out = append(out, row)
		}
	}
	return out
}
func stamp(v any) any {
	if s, ok := v.(string); ok {
		if at, e := time.Parse(time.RFC3339Nano, s); e == nil {
			return at.UTC().Format("2006-01-02T15:04:05.000Z")
		}
	}
	return nil
}
func shanghaiDay(seconds int64) string {
	return time.Unix(seconds+8*3600, 0).UTC().Format("2006-01-02")
}
