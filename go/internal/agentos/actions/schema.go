package actions

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsjobs"
	"github.com/google/uuid"
	"slices"
	"time"
	"unicode/utf8"
)

func validID(v any) bool {
	s, ok := v.(string)
	if !ok || len(s) != 36 {
		return false
	}
	id, e := uuid.Parse(s)
	return e == nil && (id == uuid.Nil || id == uuid.Max || id.Version() >= 1 && id.Version() <= 8 && id.Variant() == uuid.RFC4122)
}
func exact(o Object, required, optional []string) bool {
	if o == nil {
		return false
	}
	for _, k := range required {
		if _, ok := o[k]; !ok {
			return false
		}
	}
	for k := range o {
		if !slices.Contains(required, k) && !slices.Contains(optional, k) {
			return false
		}
	}
	return true
}
func ParseRequest(input Object) (Object, error) {
	x := clone(input)
	kind := str(x["kind"])
	required := []string{"kind"}
	optional := []string{}
	switch kind {
	case "file-cleanup-plan-create", "file-cleanup-plan-cancel":
		return parseCleanupPlanRequest(x)
	case "content-tag-create", "content-tag-update":
		return parseContentTagRequest(x)
	case "notice-draft-create", "notice-draft-save", "notice-state":
		return parseNoticeRequest(x)
	case "recommendation-policy-save", "recommendation-theme-update":
		return parseRecommendationExtended(x)
	case "strategy-draft":
		required = append(required, "configuration", "reason")
		optional = append(optional, "expectedDraftId")
	case "strategy-rehearsal":
		required = append(required, "versionId", "executionIds")
	case "strategy-publish":
		required = append(required, "versionId", "rehearsalId", "reason")
	case "ordinary-strategy-draft":
		required = append(required, "strategyId")
		optional = append(optional, "parameterEdits", "mode", "enabled")
	case "ordinary-strategy-create-draft":
		required = append(required, "sourceStrategyId", "sourceVersionId", "expectedRevision", "name", "reason")
		optional = append(optional, "parameterEdits", "mode", "enabled")
	case "ordinary-strategy-publish":
		required = append(required, "strategyId", "versionId")
	case "strategy-control":
		required = append(required, "action", "reason")
	case "strategy-continue":
		required = append(required, "runId", "decision")
	case "rule-publish":
		required = append(required, "key", "reason")
	case "rule-restore":
		required = append(required, "key", "versionId", "reason")
	case "search-draft-save", "search-apply", "search-restore", "recommendation-direction":
		return parseDiscoveryRequest(x)
	case "job-cancel", "job-retry":
		required = append(required, "targetId", "queue", "reason")
	case "search-retry":
		required = append(required, "targetId", "reason")
	case "content-visibility":
		required = append(required, "targetKind", "targetId", "action", "reason")
		optional = append(optional, "until")
	case "content-curation":
		required = append(required, "targetKind", "targetId", "reason")
		optional = append(optional, "topic", "pinned", "featured", "tagIds")
	case "public-content-batch":
		required = append(required, "items", "action", "reason")
		optional = append(optional, "until")
	case "file-scan-retry":
		required = append(required, "targetKind", "targetId", "reason")
	case "file-access":
		required = append(required, "targetKind", "targetId", "action", "reason")
		optional = append(optional, "until")
	case "file-cleanup-approve":
		required = append(required, "planId")
	case "section-classification":
		required = append(required, "targetId", "category", "reason")
	case "section-visibility":
		required = append(required, "targetId", "action", "reason")
		optional = append(optional, "until")
	case "resource-visibility":
		required = append(required, "targetId", "targetKind", "action", "reason")
		optional = append(optional, "until")
	case "case-resolve":
		required = append(required, "targetId", "resolution", "summary")
		optional = append(optional, "restrictionAction", "hideUntil")
	case "private-case-message":
		required = append(required, "reportId", "messageId", "action", "summary")
	case "account-restriction":
		required = append(required, "targetId", "action", "reason")
		optional = append(optional, "until")
	case "message-draft-create":
		required = append(required, "config")
	case "message-draft-save":
		required = append(required, "targetId", "config")
	case "messaging-state":
		required = append(required, "targetId", "action")
	case "feedback-update":
		required = append(required, "targetId")
		optional = append(optional, "category", "module", "state", "note")
	default:
		if _, e := CardReadPermission(kind); e == nil {
			return nil, fail("operations_agentos_action_not_connected", 503)
		}
		return nil, invalid()
	}
	if !exact(x, required, optional) {
		return nil, invalid()
	}
	if kind == "account-restriction" {
		value, err := operationsaccounts.NormalizeRestrictionRequest(x)
		if err != nil {
			return nil, invalid()
		}
		return value, nil
	}
	if kind == "strategy-draft" || kind == "strategy-rehearsal" || kind == "strategy-publish" || kind == "ordinary-strategy-draft" || kind == "ordinary-strategy-create-draft" || kind == "ordinary-strategy-publish" || kind == "strategy-control" || kind == "strategy-continue" || kind == "rule-publish" || kind == "rule-restore" {
		return parseStrategyRuleRequest(x)
	}
	if (kind == "job-cancel" || kind == "job-retry") && !slices.Contains(operationsjobs.Queues[:7], str(x["queue"])) {
		return nil, invalid()
	}
	if kind == "feedback-update" {
		return parseFeedbackRequest(x)
	}
	if kind == "message-draft-create" || kind == "message-draft-save" {
		config, e := messaging.ParseDraftConfiguration(x["config"])
		if e != nil {
			return nil, e
		}
		delete(config, "automation")
		x["config"] = config
	}
	if kind == "messaging-state" && !slices.Contains([]string{"activate", "pause", "resume", "stop", "withdraw"}, str(x["action"])) {
		return nil, invalid()
	}
	if kind == "private-case-message" {
		text, ok := x["summary"].(string)
		text = trim(text)
		if !validID(x["reportId"]) || !validID(x["messageId"]) || !slices.Contains([]string{"hide", "restore", "keep"}, str(x["action"])) || !ok || utf8.RuneCountInString(text) < 1 || utf8.RuneCountInString(text) > 1600 {
			return nil, invalid()
		}
		x["summary"] = text
	}
	if v, ok := x["targetId"]; ok && !validID(v) {
		return nil, invalid()
	}
	if v, ok := x["planId"]; ok && !validID(v) {
		return nil, invalid()
	}
	if reason, ok := x["reason"]; ok {
		r, ok := reason.(string)
		r = trim(r)
		maximum := 1600
		if kind == "account-restriction" {
			maximum = 2000
		}
		if !ok || utf8.RuneCountInString(r) < 3 || utf8.RuneCountInString(r) > maximum {
			return nil, invalid()
		}
		x["reason"] = r
	}
	if kind == "content-visibility" || kind == "content-curation" {
		if !slices.Contains([]string{"post", "reply"}, str(x["targetKind"])) {
			return nil, invalid()
		}
	}
	if kind == "account-restriction" {
		_, has := x["until"]
		if !slices.Contains([]string{"apply", "release"}, str(x["action"])) || (x["action"] == "apply") != has {
			return nil, invalid()
		}
		if has {
			if _, e := time.Parse(time.RFC3339Nano, str(x["until"])); e != nil {
				return nil, invalid()
			}
		}
	}
	if kind == "file-access" || kind == "file-scan-retry" {
		if !slices.Contains([]string{"chat", "forum"}, str(x["targetKind"])) {
			return nil, invalid()
		}
	}
	if kind == "resource-visibility" && !slices.Contains([]string{"projects", "methods"}, str(x["targetKind"])) {
		return nil, invalid()
	}
	if kind == "section-classification" && category(str(x["category"])) == "" {
		return nil, invalid()
	}
	if kind == "case-resolve" {
		summary, ok := x["summary"].(string)
		summary = trim(summary)
		if !ok || utf8.RuneCountInString(summary) < 3 || utf8.RuneCountInString(summary) > 1600 || !slices.Contains([]string{"accepted", "dismissed", "needs-review"}, str(x["resolution"])) {
			return nil, invalid()
		}
		x["summary"] = summary
		action := str(x["restrictionAction"])
		if _, ok := x["restrictionAction"]; ok && !slices.Contains([]string{"keep", "release", "hide"}, action) {
			return nil, invalid()
		}
		until, has := x["hideUntil"]
		if action == "" {
			action = "keep"
			if has {
				action = "hide"
			}
		}
		n, valid := integer(until)
		if (action == "hide") != has || has && (!valid || n < 1) {
			return nil, invalid()
		}
	}
	if slices.Contains([]string{"content-visibility", "public-content-batch", "file-access", "section-visibility", "resource-visibility"}, kind) {
		hide := str(x["action"]) == "hide"
		actions := []string{"hide", "restore"}
		if kind == "file-access" {
			actions = []string{"stop", "restore"}
			hide = str(x["action"]) == "stop"
		}
		if !slices.Contains(actions, str(x["action"])) {
			return nil, invalid()
		}
		v, present := x["until"]
		n, ok := integer(v)
		if hide != present || present && (!ok || n < 1 || kind == "file-access" && n > 253402300799) {
			return nil, invalid()
		}
	}
	if kind == "content-curation" {
		changed := false
		for _, k := range []string{"topic", "pinned", "featured", "tagIds"} {
			v, ok := x[k]
			if !ok {
				continue
			}
			changed = true
			switch k {
			case "topic":
				if v != nil && category(str(v)) == "" {
					return nil, invalid()
				}
			case "pinned", "featured":
				if _, ok := v.(bool); !ok {
					return nil, invalid()
				}
			case "tagIds":
				a := items(v)
				if a == nil || len(a) > 8 {
					return nil, invalid()
				}
				seen := map[string]bool{}
				for _, id := range a {
					if !validID(id) || seen[str(id)] {
						return nil, invalid()
					}
					seen[str(id)] = true
				}
			}
		}
		if !changed {
			return nil, invalid()
		}
	}
	if kind == "public-content-batch" {
		a := items(x["items"])
		if a == nil || len(a) < 1 || len(a) > 25 {
			return nil, invalid()
		}
		seen := map[string]bool{}
		for _, v := range a {
			r := obj(v)
			key := str(r["kind"]) + ":" + str(r["id"])
			if !exact(r, []string{"kind", "id"}, nil) || !slices.Contains([]string{"post", "reply"}, str(r["kind"])) || !validID(r["id"]) || seen[key] {
				return nil, invalid()
			}
			seen[key] = true
		}
	}
	return x, nil
}
