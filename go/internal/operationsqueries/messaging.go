package operationsqueries

import (
	"context"

	"slices"

	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
)

var deliveryStates = merge(shape("total pending submitting submitted delivered skipped failed unknown blocked bounced opened clicked", "n"), Object{"receipts": "s"})
var accountShape = merge(shape("accountId uid displayName subjectType createdAt", "s"), Object{"profileRevision": "n", "restriction": Object{"active": "b", "until": "s"}})

func messagePlan(x Object) Object {
	channels := []any{}
	if a, ok := x["config"].(map[string]any); ok {
		switch c := a["channels"].(type) {
		case []any:
			for _, v := range c {
				if slices.Contains([]string{"announcement", "inapp", "email"}, str(v)) {
					channels = append(channels, v)
				}
			}
		case []string:
			for _, v := range c {
				if slices.Contains([]string{"announcement", "inapp", "email"}, v) {
					channels = append(channels, v)
				}
			}
		}
	}
	return merge(object(project(x, merge(shape("id state effectiveState createdAt updatedAt", "s"), shape("version revision", "n")))), Object{"channels": channels, "purpose": text(object(object(x["config"])["content"])["purpose"]), "expiresAt": text(object(object(x["config"])["content"])["expiresAt"]), "schedule": project(object(x["config"])["schedule"], shape("kind at cron timezone", "s"))})
}
func messageRun(x Object) Object {
	return object(project(x, merge(shape("id planId state errorCode createdAt updatedAt completedAt", "s"), shape("revision planVersion", "n"), Object{"audience": Object{"accountCount": "n", "frozenAt": "s"}, "delivery": Object{"email": deliveryStates, "inapp": deliveryStates}, "announcement": shape("id state publishedAt expiresAt withdrawnAt", "s")})))
}
func messageSummary(x Object) Object {
	return object(project(x, Object{"scope": "s", "plans": shape("total draft active paused stopped", "n"), "runs": shape("total running paused blocked completed cancelled expired", "n"), "delivery": Object{"inapp": deliveryStates, "email": deliveryStates}}))
}
func historyItem(x Object) Object {
	return object(project(x, merge(shape("id sequence kind createdAt operatorDisplayName", "s"), shape("version revision publishedVersion", "n"))))
}
func recipientItem(x Object) Object {
	return object(project(x, merge(shape("id channel state errorCode retryAt submittedAt completedAt", "s"), Object{"attemptCount": "n", "deferred": "b", "retryable": "b", "account": accountShape, "attempts": []any{merge(shape("number", "n"), shape("state errorCode startedAt finishedAt", "s"), Object{"networkAttempt": "b"})}})))
}
func (s *Service) execute(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if args.module == "accounts" {
		return s.accounts(ctx, a, args)
	}
	if args.module == "runs" || args.module == "jobs" {
		return s.runtimeRead(ctx, a, args)
	}
	if args.module == "permissions" {
		return s.permissionsRead(ctx, a, args)
	}
	if args.module == "analytics" || args.module == "recommendations" || args.module == "search" {
		return s.discoveryRead(ctx, a, args)
	}
	if args.module == "feedback" {
		return s.feedback(ctx, a, args)
	}
	switch args.module {
	case "content", "cases":
		return s.community(ctx, a, args)
	case "resources":
		return s.resources(ctx, a, args)
	case "files":
		return s.files(ctx, a, args)
	case "chat-reports":
		return s.chatReports(ctx, a, args)
	case "strategies":
		return s.strategies(ctx, a, args)
	case "rules":
		return s.rules(ctx, a, args)
	case "maintenance":
		return s.maintenance(ctx, a, args)
	}
	if args.module == "system-settings" {
		return s.settings(ctx, a, args)
	}
	if args.module == "registered-users" {
		return s.registered(ctx, a, args)
	}
	if args.module == "audit" {
		return s.audit(ctx, a, args)
	}
	if args.module != "messaging" || s.Messaging == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	// A read-only facade shares the running service's actual source/clock/mail
	// instance and uses the owning query authority; no mutable sender is copied.
	source := &messaging.Service{Pool: s.Messaging.Pool, Endpoint: s.Messaging.Endpoint, Authority: s.reader(a), Now: s.Messaging.Now, Mail: s.Messaging.Mail}
	if args.kind != "" {
		return s.readMessage(ctx, source, a, args)
	}
	filters := Object{}
	for k, v := range args.filters {
		filters[k] = v
	}
	var result Object
	var e error
	projector := messagePlan
	kind := "message-plan"
	switch args.view {
	case "plans":
		result, e = source.List(ctx, a, filters)
	case "runs":
		result, e = source.Runs(ctx, a, filters)
		projector = messageRun
		kind = "message-run"
	case "history":
		id := str(filters["planId"])
		delete(filters, "planId")
		result, e = source.History(ctx, a, id, filters)
		projector = historyItem
		kind = ""
	case "recipients":
		id := str(filters["runId"])
		delete(filters, "runId")
		result, e = source.Recipients(ctx, a, id, filters)
		projector = recipientItem
		kind = ""
	}
	if e != nil {
		return queryResult{}, e
	}
	items, ok := result["items"].([]any)
	if !ok {
		return queryResult{}, fail("operations_query_response_invalid", 503)
	}
	rows := []any{}
	refs := []reference{}
	for _, v := range items {
		x := object(v)
		rows = append(rows, projector(x))
		if kind != "" {
			refs = append(refs, reference{kind: kind, id: str(x["id"]), row: x})
		}
	}
	next := result["nextAfter"]
	var resume any
	if next != nil && next != "" {
		resume = Object{"module": args.module, "view": args.view, "filters": merge(args.filters, Object{"after": next})}
	}
	data := Object{"items": rows, "coverage": "returned-page", "scanLimited": result["scanTruncated"] == true || result["scanLimited"] == true}
	if result["summary"] != nil {
		data["summary"] = messageSummary(object(result["summary"]))
	}
	if args.view == "recipients" {
		data["runId"] = args.filters["runId"]
	}
	return queryResult{source: result, data: data, refs: refs, pagination: Object{"next": resume, "complete": resume == nil && result["scanTruncated"] != true && result["scanLimited"] != true}}, nil
}
func (s *Service) readMessage(ctx context.Context, source *messaging.Service, a Actor, args arguments) (queryResult, error) {
	if args.kind == "message-run" {
		result, e := source.Run(ctx, a, args.id)
		if e != nil {
			return queryResult{}, e
		}
		row := object(result["run"])
		return queryResult{source: result, data: messageRun(row), refs: []reference{{kind: args.kind, id: args.id, row: row, filters: args.filters}}}, nil
	}
	if args.kind != "message-plan" {
		return queryResult{}, invalid()
	}
	result, e := source.Get(ctx, a, args.id)
	if e != nil {
		return queryResult{}, e
	}
	row := object(result["plan"])
	plan := messagePlan(row)
	purpose := ""
	if row["state"] == "draft" {
		config, e := messaging.ParseConfiguration(row["config"])
		if e != nil {
			return queryResult{}, fail("operations_query_response_invalid", 503)
		}
		plan = merge(plan, Object{"config": config, "contentTrust": "untrusted-source", "instructionAuthority": "none"})
		purpose = "message-draft-editing"
	}
	runs := []any{}
	if all, ok := result["recentRuns"].([]any); ok {
		for _, v := range all {
			runs = append(runs, messageRun(object(v)))
		}
	}
	return queryResult{source: result, data: Object{"plan": plan, "recentRuns": runs}, purpose: purpose, refs: []reference{{kind: args.kind, id: args.id, row: row, filters: args.filters, purpose: purpose}}}, nil
}
