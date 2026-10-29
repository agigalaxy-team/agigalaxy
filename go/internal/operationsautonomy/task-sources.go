package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func proposalTargetTypeSQL(p string) string {
	return `CASE ` + p + `->'target'->>'kind' WHEN 'post' THEN 'content-post' WHEN 'reply' THEN 'content-reply' WHEN 'section' THEN 'content-section' WHEN 'account' THEN 'account' WHEN 'case' THEN 'community-report' WHEN 'public-case' THEN 'community-report' WHEN 'chat-report' THEN 'chat-report' WHEN 'chat-file' THEN 'file-chat' WHEN 'forum-file' THEN 'file-forum' WHEN 'message-plan' THEN 'messaging-plan' WHEN 'projects' THEN 'project' WHEN 'methods' THEN 'method' WHEN 'rule' THEN 'rule-key' WHEN 'file' THEN CASE ` + p + `->'request'->>'targetKind' WHEN 'chat' THEN 'file-chat' WHEN 'forum' THEN 'file-forum' END WHEN 'search-configuration' THEN 'search-quality' WHEN 'recommendation-theme' THEN 'recommendation-policy' WHEN 'ai-work-prompt' THEN 'ai-work-account' WHEN 'public-content-batch' THEN NULL ELSE ` + p + `->'target'->>'kind' END`
}
func taskSourceRefsSQL(endpoint, task string) string {
	card := `c.endpoint=` + endpoint + ` AND (c.turn_id=` + task + ` OR EXISTS(SELECT 1 FROM operations_autonomy_workbench_runs_v1 w WHERE w.endpoint=c.endpoint AND w.task_id=` + task + ` AND w.turn_operation_id=c.turn_id))`
	return `SELECT DISTINCT target_type,target_id FROM operations_autonomy_receipts_v1 WHERE endpoint=` + endpoint + ` AND task_id=` + task + ` AND target_type IS NOT NULL
 UNION SELECT 'content-'||(item->>'kind'),item->>'id' FROM operations_autonomy_receipts_v1 r CROSS JOIN LATERAL jsonb_array_elements(r.details->'items') item WHERE r.endpoint=` + endpoint + ` AND r.task_id=` + task + `
 UNION SELECT ` + proposalTargetTypeSQL("o.proposal") + `,o.proposal->'target'->>'id' FROM operations_ai_duty_operations_v1 o WHERE o.endpoint=` + endpoint + ` AND o.task_id=` + task + ` AND o.kind<>'public-content-batch'
 UNION SELECT 'content-'||(item->>'kind'),item->>'id' FROM operations_ai_duty_operations_v1 o CROSS JOIN LATERAL jsonb_array_elements(o.request->'items') item WHERE o.endpoint=` + endpoint + ` AND o.task_id=` + task + ` AND o.kind='public-content-batch'
 UNION SELECT ` + proposalTargetTypeSQL("c.proposal") + `,c.proposal->'target'->>'id' FROM operations_agentos_conversation_cards_v1 c WHERE ` + card + ` AND c.proposal->>'kind'<>'public-content-batch'
 UNION SELECT 'content-'||(item->>'kind'),item->>'id' FROM operations_agentos_conversation_cards_v1 c CROSS JOIN LATERAL jsonb_array_elements(c.proposal->'request'->'items') item WHERE ` + card + ` AND c.proposal->>'kind'='public-content-batch'`
}
func (s *Service) TaskSourceRefsWithin(ctx context.Context, tx pgx.Tx, id string) ([]Object, error) {
	rows, e := many(ctx, tx, "SELECT to_jsonb(r) FROM("+taskSourceRefsSQL("$1", "$2")+")r", s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	out := []Object{}
	for _, r := range rows {
		if str(r["target_type"]) != "" && str(r["target_id"]) != "" {
			out = append(out, r)
		}
	}
	return out, nil
}

// Fetch source references for the selected tasks in one transaction round trip.
// The same source query remains the authority for which references exist.
func (s *Service) taskSourceRefsForTasksWithin(ctx context.Context, tx pgx.Tx, ids []string) (map[string][]Object, error) {
	out := make(map[string][]Object, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	query := `SELECT to_jsonb(r) FROM (SELECT candidates.id AS task_id, refs.target_type, refs.target_id
		FROM unnest($2::text[]) AS candidates(id)
		CROSS JOIN LATERAL (` + taskSourceRefsSQL("$1", "candidates.id::uuid") + `) refs) r`
	rows, err := many(ctx, tx, query, s.Endpoint, ids)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if str(row["target_type"]) == "" || str(row["target_id"]) == "" {
			continue
		}
		id := str(row["task_id"])
		out[id] = append(out[id], Object{"target_type": row["target_type"], "target_id": row["target_id"]})
	}
	return out, nil
}

// Use the same per-target checks for a pre-fetched reference set. Nothing from
// this transaction-local map substitutes for a fresh authorization barrier.
func (s *Service) checkTargetWithRefsWithin(ctx context.Context, tx pgx.Tx, a Actor, row Object, refs []Object) error {
	for _, ref := range refs {
		target := Object{"domain": row["domain"], "target_type": ref["target_type"], "target_id": ref["target_id"]}
		if err := s.checkTargetWithin(ctx, tx, a, target, false); err != nil {
			return err
		}
	}
	return s.checkTargetWithin(ctx, tx, a, row, false)
}

var taskReadMap = map[string]string{"content-post": "post", "content-reply": "reply", "content-section": "section", "business-account": "account", "account": "account", "section": "section", "community-report": "case", "case": "case", "chat-report": "chat-report", "feedback": "feedback", "project": "project", "method": "method", "file-chat": "chat-file", "file-forum": "forum-file", "file-cleanup-plan": "file-cleanup-plan", "messaging-plan": "message-plan", "rule-key": "rule", "strategy-run": "strategy-run"}
var modulePermission = map[string]string{"recommendation-policy": "recommendations.read", "search-quality": "search-quality.read", "maintenance": "maintenance.read", "ai-role": "permissions.read", "ai-role-assignment": "ai.accounts.read", "ai-work-account": "ai.accounts.read", "strategy": "strategies.read", "strategy-configuration": "strategies.read"}
var kindPermission = map[string]string{"post": "content.read", "reply": "content.read", "section": "sections.read", "account": "accounts.read", "case": "cases.read", "chat-report": "chat-reports.read", "feedback": "feedback.read", "project": "resources.read", "method": "resources.read", "chat-file": "files.read", "forum-file": "files.read", "file-cleanup-plan": "files.read", "message-plan": "notices.read", "rule": "rules.read", "strategy-run": "strategies.read"}

func (s *Service) checkTargetWithin(ctx context.Context, tx pgx.Tx, a Actor, row Object, includeReceipts bool) error {
	if includeReceipts {
		refs, e := s.TaskSourceRefsWithin(ctx, tx, str(row["id"]))
		if e != nil {
			return e
		}
		return s.checkTargetWithRefsWithin(ctx, tx, a, row, refs)
	}
	if row["target_type"] == nil || row["target_type"] == "" {
		return nil
	}
	kind := taskReadMap[str(row["target_type"])]
	if kind != "" {
		if s.ReadTargetWithin == nil {
			return fault.New("operations_autonomy_source_unavailable", 503)
		}
		viewer, e := s.actor(ctx, tx, a, kindPermission[kind], nil)
		if e != nil {
			return e
		}
		value, e := s.ReadTargetWithin(ctx, tx, viewer, str(row["domain"]), kind, str(row["target_id"]))
		if e != nil {
			return e
		}
		if value["availability"] != nil && value["availability"] != "" && value["availability"] != "available" {
			return fail("operations_autonomy_source_unavailable")
		}
		_, e = s.actor(ctx, tx, viewer, kindPermission[kind], nil)
		return e
	}
	permission := modulePermission[str(row["target_type"])]
	if permission == "" {
		return fail("operations_autonomy_source_unavailable")
	}
	_, e := s.actor(ctx, tx, a, permission, nil)
	return e
}
