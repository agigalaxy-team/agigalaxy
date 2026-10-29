package operationsautonomy

import (
	"context"
	"github.com/jackc/pgx/v5"
)

var reportSectionPermissions = map[string][]string{
	"workbench": {"workbench.read"}, "maintenance": {"maintenance.read", "jobs.read"}, "search": {"search-quality.read"}, "recommendations": {"recommendations.read"}, "analytics": {"analytics.read"}, "messaging": {"notices.read"}, "autonomy": {"autonomy.read"}, "delegation": {"ai.roles.read", "ai.prompts.read"},
}
var reportBlockPermissions = map[string]string{"communityReports": "cases.read", "chatReports": "chat-reports.read", "sections": "sections.read", "resources": "resources.read", "files": "files.read", "jobs": "jobs.read", "feedback": "feedback.read", "search": "search.read"}

func (s *Service) reportAllowed(ctx context.Context, tx pgx.Tx, actor Actor, actions []string) bool {
	for _, action := range actions {
		if _, err := s.actor(ctx, tx, actor, action, nil); err != nil {
			return false
		}
	}
	return true
}
func (s *Service) taskReportWithin(ctx context.Context, tx pgx.Tx, row Object, actor Actor) (Object, error) {
	calls, err := many(ctx, tx, `SELECT to_jsonb(c) FROM (SELECT call_id,operation_id,tool,state,code,arguments,read_outcome,updated_at FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND task_id=$2 ORDER BY updated_at DESC,call_id DESC) c`, s.Endpoint, row["id"])
	if err != nil {
		return nil, err
	}
	var latest, assessment Object
	for _, call := range calls {
		if latest == nil && call["tool"] == "inspect-operations" && obj(obj(call["read_outcome"])["inspectionReport"]) != nil {
			latest = call
		}
		if assessment == nil && call["tool"] == "assess-task" && call["state"] == "completed" && call["code"] == "task-assessment-current" {
			assessment = obj(call["arguments"])
		}
	}
	var inspection any
	if latest != nil {
		report := inspectionReport(obj(obj(latest["read_outcome"])["inspectionReport"]))
		if report != nil {
			s.filterInspectionReportWithin(ctx, tx, actor, report)
			report["callId"], report["observedAt"] = latest["call_id"], iso(latest["updated_at"])
			inspection = report
		}
	}
	var analysis any
	stored := obj(obj(row["result"])["analysis"])
	allowed := s.analysisSourcesAllowedWithin(ctx, tx, row, actor, calls)
	if stored != nil {
		if !allowed {
			analysis = Object{"state": "withheld", "reason": "source-unverified"}
		} else {
			a := Object{}
			for _, key := range []string{"state", "basis", "nativeRunId", "text", "byteLength", "recordedAt", "reason"} {
				if stored[key] != nil {
					a[key] = stored[key]
				}
			}
			analysis = a
		}
	}
	var summary any
	if allowed && assessment != nil {
		if _, ok := text(assessment["summary"], 0, 1000, false); ok {
			summary = assessment["summary"]
		}
	}
	if report := obj(inspection); report != nil {
		s.filterInspectionReportWithin(ctx, tx, actor, report)
	}
	if allowed && !s.analysisSourcesAllowedWithin(ctx, tx, row, actor, calls) {
		if stored != nil {
			analysis = Object{"state": "withheld", "reason": "source-unverified"}
		}
		summary = nil
	}
	return Object{"inspectionReport": inspection, "finalAnalysis": analysis, "assessmentSummary": summary}, nil
}

func (s *Service) filterInspectionReportWithin(ctx context.Context, tx pgx.Tx, actor Actor, report Object) {
	accessComplete := report["accessComplete"] != false
	for key := range inspectionSections {
		section := obj(obj(report["sections"])[key])
		if section == nil {
			accessComplete = false
			continue
		}
		if !s.reportAllowed(ctx, tx, actor, reportSectionPermissions[key]) {
			section["availability"], section["complete"], section["facts"], section["findingCodes"], section["window"], section["coverage"] = "not-authorized", false, nil, []any{"not-authorized"}, nil, nil
			accessComplete = false
			continue
		}
		if key == "workbench" {
			counts := obj(obj(section["facts"])["counts"])
			for block, permission := range reportBlockPermissions {
				if !s.reportAllowed(ctx, tx, actor, []string{permission}) && counts != nil {
					counts[block] = nil
					accessComplete = false
				}
			}
		}
	}
	report["accessComplete"] = accessComplete
}

// A historical response may contain more than the report's aggregate facts.
// Only fixed-profile aggregate reads and supported exact sources can be proved.
func (s *Service) analysisSourcesAllowedWithin(ctx context.Context, tx pgx.Tx, row Object, actor Actor, calls []Object) bool {
	if err := s.checkTargetWithin(ctx, tx, actor, row, true); err != nil {
		return false
	}
	observed := false
	for _, call := range calls {
		if call["state"] != "completed" {
			continue
		}
		tool, args := str(call["tool"]), obj(call["arguments"])
		switch tool {
		case "assess-task", "reconcile-task-operations":
			continue
		case "current-summary":
			if len(texts(row["event_ids"])) != 0 || !s.reportAllowed(ctx, tx, actor, []string{"autonomy.read"}) {
				return false
			}
			observed = true
		case "inspect-operations":
			report := obj(obj(call["read_outcome"])["inspectionReport"])
			if report == nil {
				return false
			}
			observed = true
			for key, permissions := range reportSectionPermissions {
				section := obj(obj(report["sections"])[key])
				facts := obj(section["facts"])
				if (key == "search" || key == "recommendations") && has([]string{"available", "partial"}, str(section["availability"])) && !s.reportAllowed(ctx, tx, actor, permissions) {
					return false
				}
				if key == "delegation" {
					if hasReportValue(facts["targetCount"]) && !s.reportAllowed(ctx, tx, actor, []string{"ai.roles.read"}) {
						return false
					}
					if num(facts["promptsRead"]) > 0 && !s.reportAllowed(ctx, tx, actor, []string{"ai.prompts.read"}) {
						return false
					}
					continue
				}
				if !hasReportValue(facts) {
					continue
				}
				if !s.reportAllowed(ctx, tx, actor, permissions) {
					return false
				}
				if key == "workbench" {
					counts := obj(facts["counts"])
					for block, permission := range reportBlockPermissions {
						if hasReportValue(counts[block]) && !s.reportAllowed(ctx, tx, actor, []string{permission}) {
							return false
						}
					}
				}
			}
		case "read-ai-delegation":
			observed = true
			permission := "ai.roles.read"
			if args["aiAccountId"] != nil {
				permission = "ai.prompts.read"
			}
			if !s.reportAllowed(ctx, tx, actor, []string{permission}) {
				return false
			}
		case "manage-ai-role", "manage-ai-prompt", "execute-operation":
			permission := ""
			if tool == "manage-ai-role" {
				permission = "ai.roles.read"
			}
			if tool == "manage-ai-prompt" {
				permission = "ai.prompts.read"
			}
			if permission != "" && !s.reportAllowed(ctx, tx, actor, []string{permission}) {
				return false
			}
			operationID := str(call["operation_id"])
			if !schemaUUID.MatchString(operationID) {
				return false
			}
			receipt, err := optional(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT operation_id,state FROM operations_autonomy_receipts_v1 WHERE endpoint=$1 AND task_id=$2 AND operation_id=$3) r`, s.Endpoint, row["id"], operationID)
			if err != nil || receipt == nil || !has([]string{"completed", "failed", "unknown", "no-action"}, str(receipt["state"])) {
				return false
			}
			observed = true
		case "query-operations", "read-operation-object":
			observed = true
			if s.QueryReadPermission == nil {
				return false
			}
			permission, err := s.QueryReadPermission(tool, args)
			if err != nil || !s.reportAllowed(ctx, tx, actor, []string{permission}) {
				return false
			}
			if tool == "read-operation-object" {
				kind := str(args["kind"])
				target := map[string]string{"feedback": "feedback", "post": "content-post", "reply": "content-reply"}[kind]
				if target == "" || s.checkTargetWithin(ctx, tx, actor, Object{"target_type": target, "target_id": args["id"], "domain": row["domain"]}, false) != nil {
					return false
				}
			} else {
				module, view := str(args["module"]), str(args["view"])
				metadata := module == "permissions" && has([]string{"roles", "personnel", "automation"}, view)
				if !fixedOverviewScope(call) && !metadata {
					return false
				}
			}
		default:
			return false
		}
	}
	return observed && s.checkTargetWithin(ctx, tx, actor, row, true) == nil
}

func hasReportValue(value any) bool {
	if value == nil {
		return false
	}
	if values, ok := value.(map[string]any); ok {
		for _, v := range values {
			if hasReportValue(v) {
				return true
			}
		}
		return false
	}
	if values, ok := value.([]any); ok {
		for _, v := range values {
			if hasReportValue(v) {
				return true
			}
		}
		return false
	}
	return true
}
