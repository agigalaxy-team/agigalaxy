package operationsqueries

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/registeredusers"
	"regexp"
	"slices"
	"strconv"
)

var sequence = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
var kinds = map[string]string{"account": "accounts", "account-summary": "accounts", "registered-user": "registered-users", "post": "content", "reply": "content", "section": "content", "case": "cases", "chat-report": "chat-reports", "feedback": "feedback", "chat-file": "files", "forum-file": "files", "file-cleanup-plan": "files", "file-cleanup-operation": "files", "project": "resources", "method": "resources", "message-plan": "messaging", "message-run": "messaging", "rule": "rules", "strategy-run": "strategies", "ai-run": "runs", "backup-point": "maintenance", "restore-plan": "maintenance", "role": "permissions"}
var views = map[string][]string{"accounts": {"list", "summary"}, "registered-users": {"list"}, "system-settings": {"overview", "general", "mail", "service-connections", "advanced"}, "content": {"list", "sections", "tags"}, "cases": {"list"}, "chat-reports": {"list"}, "feedback": {"list"}, "files": {"list", "summary", "cleanup-candidates", "cleanup-plans"}, "resources": {"projects", "methods"}, "analytics": {"overview", "business", "retention", "paths", "account"}, "recommendations": {"overview", "history"}, "search": {"overview", "history"}, "messaging": {"plans", "runs", "recipients", "history"}, "strategies": {"overview", "versions", "records"}, "rules": {"overview", "versions"}, "maintenance": {"overview", "backups", "plans", "logs"}, "audit": {"list"}, "runs": {"list"}, "jobs": {"list"}, "permissions": {"roles", "personnel", "automation"}}

func parse(tool string, input Object) (arguments, error) {
	a := arguments{}
	var e error
	input, e = normalizeQueryArguments(tool, input)
	if e != nil {
		return a, e
	}
	switch tool {
	case "query-operations":
		if !exact(input, "module", "view", "filters") {
			return a, invalid()
		}
		a.module = str(input["module"])
		a.view = str(input["view"])
		if !slices.Contains(views[a.module], a.view) {
			return a, invalid()
		}
	case "read-operation-object":
		if !exact(input, "kind", "id", "filters") {
			return a, invalid()
		}
		a.kind = str(input["kind"])
		a.id = str(input["id"])
		a.module = kinds[a.kind]
		if a.module == "" {
			return a, invalid()
		}
		if a.kind == "rule" {
			if !regexp.MustCompile(`^[a-z][a-z0-9-]{1,79}$`).MatchString(a.id) {
				return a, invalid()
			}
		} else if a.kind == "backup-point" {
			if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(a.id) {
				return a, invalid()
			}
		} else if a.kind == "ai-run" {
			if !regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`).MatchString(a.id) {
				return a, invalid()
			}
		} else if !validID(a.id) {
			return a, invalid()
		}
	default:
		return a, invalid()
	}
	a.filters = Object{}
	_, filtersPresent := input["filters"]
	if v, present := input["filters"]; present {
		o := object(v)
		if o == nil {
			return a, invalid()
		}
		for k, v := range o {
			a.filters[k] = v
		}
	}
	if tool == "read-operation-object" {
		if a.kind != "account-summary" && !exact(a.filters) {
			return a, invalid()
		}
		return a, nil
	}
	// Zod's outer .default({}) supplies this object without evaluating the
	// nested schema; only explicitly supplied filters receive inner defaults.
	if !filtersPresent {
		return a, nil
	}
	if a.module == "system-settings" {
		if !exact(a.filters) {
			return a, invalid()
		}
		return a, nil
	}
	if a.module == "content" && a.view == "tags" || a.module == "strategies" && a.view == "overview" || a.module == "rules" && a.view == "overview" || a.module == "maintenance" && a.view == "overview" || a.module == "permissions" {
		if !exact(a.filters) {
			return a, invalid()
		}
	}
	if a.module == "resources" && a.view == "methods" {
		if _, present := a.filters["state"]; present {
			return a, invalid()
		}
	}
	if a.module == "content" && a.view == "list" && str(a.filters["query"]) != "" {
		if visibility, exists := a.filters["visibility"]; exists && visibility != "visible" {
			return a, invalid()
		}
	}
	if a.module == "audit" {
		// The owning audit schema retains its own cursor contract below.
		q, e := operationsaudit.Parse(a.filters)
		if e != nil {
			return a, invalid()
		}
		a.filters = q
		return a, nil
	}
	if a.module == "analytics" && (a.view == "retention" || a.view == "paths") && a.filters["accountId"] != nil && a.filters["scope"] != "accounts" {
		return a, invalid()
	}
	if a.module == "registered-users" {
		q, e := registeredusers.ParseList(a.filters)
		if e != nil {
			return a, invalid()
		}
		a.filters = q
		return a, nil
	}
	if a.module == "messaging" {
		allowed := []string{"after", "limit"}
		switch a.view {
		case "plans":
			allowed = append(allowed, "state")
		case "runs":
			allowed = append(allowed, "planId")
		case "recipients":
			allowed = append(allowed, "runId", "state", "channel")
		case "history":
			allowed = append(allowed, "planId")
		}
		if !exact(a.filters, allowed...) {
			return a, invalid()
		}
		if v, ok := a.filters["after"]; ok {
			t, ok := v.(string)
			if !ok || !sequence.MatchString(t) {
				return a, invalid()
			}
			if _, e := strconv.ParseInt(t, 10, 64); e != nil {
				return a, invalid()
			}
		}
		if v, ok := a.filters["limit"]; ok {
			n, ok := number(v)
			if !ok || n < 1 || n > 100 || n != float64(int(n)) {
				return a, invalid()
			}
			a.filters["limit"] = int(n)
		} else {
			a.filters["limit"] = 30
		}
		for _, key := range []string{"planId", "runId"} {
			if v, ok := a.filters[key]; ok && !validID(v) {
				return a, invalid()
			}
		}
		if a.view == "recipients" && !validID(a.filters["runId"]) || a.view == "history" && !validID(a.filters["planId"]) {
			return a, invalid()
		}
		if v, ok := a.filters["channel"]; ok && !slices.Contains([]string{"inapp", "email"}, str(v)) {
			return a, invalid()
		}
		if v, ok := a.filters["state"]; ok {
			allowed := []string{"draft", "active", "paused", "stopped"}
			if a.view == "recipients" {
				allowed = []string{"pending", "submitting", "submitted", "delivered", "skipped", "failed", "unknown", "blocked"}
			}
			if !slices.Contains(allowed, str(v)) {
				return a, invalid()
			}
		}
	}
	return a, nil
}
