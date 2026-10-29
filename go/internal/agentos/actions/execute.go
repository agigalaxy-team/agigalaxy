package actions

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsjobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"slices"
	"time"
)

func (s *Service) proposal(proposal Object, operationID string) (Object, Object, error) {
	if !validID(operationID) {
		return nil, nil, invalid()
	}
	x, e := ParseRequest(obj(proposal["request"]))
	if e != nil {
		return nil, nil, e
	}
	if num(proposal["schemaVersion"]) != 1 || proposal["kind"] != x["kind"] || proposal["requiredAction"] != required(x) {
		return nil, nil, invalid()
	}
	command := clone(obj(proposal["command"]))
	command["operationId"] = operationID
	for _, key := range []string{"reason", "topic", "pinned", "featured", "tagIds", "category", "resolution", "summary", "restrictionAction", "hideUntil"} {
		if v, ok := x[key]; ok && !same(v, command[key]) {
			return nil, nil, invalid()
		}
	}
	kind := str(x["kind"])
	switch kind {
	case "file-cleanup-plan-create", "file-cleanup-plan-cancel":
		var err error
		command, err = normalizeCleanupPlanCommand(x, command, proposal)
		if err != nil {
			return nil, nil, err
		}
	case "content-tag-create", "content-tag-update":
		var err error
		command, err = normalizeContentTagCommand(x, command, proposal)
		if err != nil {
			return nil, nil, err
		}
	case "recommendation-policy-save", "recommendation-theme-update":
		var err error
		command, err = normalizeRecommendationExtended(x, command, proposal)
		if err != nil {
			return nil, nil, err
		}
	case "notice-draft-create", "notice-draft-save", "notice-state":
		var err error
		command, err = normalizeNoticeCommand(x, command, proposal, operationID)
		if err != nil {
			return nil, nil, err
		}
	case "strategy-draft", "strategy-rehearsal", "strategy-publish", "ordinary-strategy-draft", "ordinary-strategy-publish", "strategy-control", "strategy-continue", "rule-publish", "rule-restore":
		var err error
		command, err = normalizeStrategyRuleCommand(x, command)
		if err != nil {
			return nil, nil, err
		}
	case "search-draft-save", "search-apply", "search-restore", "recommendation-direction":
		var err error
		command, err = normalizeDiscoveryCommand(x, command, proposal)
		if err != nil {
			return nil, nil, err
		}
	case "job-cancel", "job-retry", "search-retry":
		var err error
		command, err = operationsjobs.ParseCommand(kind, command)
		if err != nil {
			return nil, nil, err
		}
	case "feedback-update":
		var err error
		command, err = normalizedFeedbackCommand(command)
		if err != nil {
			return nil, nil, invalid()
		}
		for _, key := range []string{"category", "module", "state", "note"} {
			if v, ok := x[key]; ok && !same(v, command[key]) {
				return nil, nil, invalid()
			}
		}
	case "message-draft-create", "message-draft-save":
		keys := []string{"operationId", "config", "expectedVersion", "expectedRevision"}
		if kind == "message-draft-create" {
			keys = []string{"operationId", "planId", "config"}
		}
		if !exact(command, keys, nil) {
			return nil, nil, invalid()
		}
		config, err := messaging.ParseConfiguration(command["config"])
		if err != nil {
			return nil, nil, invalid()
		}
		expected, err := messaging.ParseDraftConfiguration(x["config"])
		if err != nil || !same(config, expected) {
			return nil, nil, invalid()
		}
		command["config"] = config
		planID := x["targetId"]
		if kind == "message-draft-create" {
			planID = operationID
			if command["planId"] != operationID {
				return nil, nil, invalid()
			}
		} else {
			for _, key := range []string{"expectedVersion", "expectedRevision"} {
				n, ok := integer(command[key])
				if !ok || n < 1 || n > 2147483646 {
					return nil, nil, invalid()
				}
			}
		}
		if obj(proposal["target"])["id"] != planID {
			return nil, nil, invalid()
		}
	case "messaging-state":
		if !exact(command, []string{"operationId", "expectedVersion", "expectedRevision"}, nil) {
			return nil, nil, invalid()
		}
		for _, key := range []string{"expectedVersion", "expectedRevision"} {
			n, ok := integer(command[key])
			if !ok || n < 1 || n > 2147483646 {
				return nil, nil, invalid()
			}
		}
	case "account-restriction":
		var err error
		command, err = operationsaccounts.ParseRestriction(command, x["action"] == "release")
		if err != nil {
			return nil, nil, invalid()
		}
	case "private-case-message":
		if !exact(command, []string{"operationId", "expectedVersion", "expectedRevision", "messageRevision", "action", "summary"}, nil) || command["action"] != x["action"] {
			return nil, nil, invalid()
		}
		for _, key := range []string{"expectedVersion", "expectedRevision", "messageRevision"} {
			n, ok := integer(command[key])
			if !ok || key != "expectedRevision" && n < 1 {
				return nil, nil, invalid()
			}
		}
	case "content-visibility":
		if !exact(command, []string{"operationId", "kind", "expectedVersion", "expectedRevision", "reason"}, []string{"until"}) || command["kind"] != x["action"] {
			return nil, nil, invalid()
		}
	case "content-curation":
		if !exact(command, []string{"operationId", "expectedVersion", "expectedRevision", "reason"}, []string{"topic", "pinned", "featured", "tagIds"}) {
			return nil, nil, invalid()
		}
	case "public-content-batch":
		if !exact(command, []string{"operationId", "kind", "items", "reason"}, []string{"until"}) || command["kind"] != x["action"] {
			return nil, nil, invalid()
		}
		rows, selected := items(command["items"]), items(x["items"])
		if len(rows) != len(selected) {
			return nil, nil, invalid()
		}
		for i, v := range rows {
			r := obj(v)
			if !same(pick(r, "kind", "id"), selected[i]) || !exact(r, []string{"kind", "id", "expectedVersion", "expectedRevision"}, nil) {
				return nil, nil, invalid()
			}
			for _, k := range []string{"expectedVersion", "expectedRevision"} {
				if n, ok := integer(r[k]); !ok || n > 2147483646 {
					return nil, nil, invalid()
				}
			}
		}
	case "file-scan-retry":
		var e error
		command, e = filegovernance.ParseRetry(command)
		if e != nil || command["kind"] != "scan" {
			return nil, nil, invalid()
		}
	case "file-access":
		var e error
		command, e = filegovernance.ParseAccessChange(command)
		if e != nil || command["action"] != x["action"] {
			return nil, nil, invalid()
		}
	case "file-cleanup-approve":
		if !exact(command, []string{"operationId", "expectedRevision"}, nil) || num(command["expectedRevision"]) < 1 || num(command["expectedRevision"]) > 2147483646 {
			return nil, nil, invalid()
		}
	case "section-classification":
		if !exact(command, []string{"operationId", "expectedVersion", "category", "reason"}, nil) {
			return nil, nil, invalid()
		}
	case "section-visibility", "resource-visibility":
		if !exact(command, []string{"operationId", "expectedVersion", "expectedVisibilityVersion", "kind", "reason"}, []string{"until"}) || command["kind"] != x["action"] {
			return nil, nil, invalid()
		}
		if n, ok := integer(command["expectedVisibilityVersion"]); !ok || n > 2147483646 {
			return nil, nil, invalid()
		}
	case "case-resolve":
		if !exact(command, []string{"operationId", "expectedVersion", "resolution", "summary"}, []string{"restrictionAction", "hideUntil"}) {
			return nil, nil, invalid()
		}
	}
	if slices.Contains([]string{"section-classification", "section-visibility", "resource-visibility", "case-resolve"}, kind) {
		if n, ok := integer(command["expectedVersion"]); !ok || n > 2147483646 {
			return nil, nil, invalid()
		}
	}
	if kind == "content-visibility" || kind == "content-curation" {
		for _, key := range []string{"expectedVersion", "expectedRevision"} {
			if n, ok := integer(command[key]); !ok || n > 2147483646 {
				return nil, nil, invalid()
			}
		}
	}
	if v, ok := x["until"]; ok {
		if !same(v, command["until"]) {
			return nil, nil, invalid()
		}
	} else if _, present := command["until"]; present {
		return nil, nil, invalid()
	}
	return x, command, nil
}
func unknown(operationID string) Object {
	return Object{"operationId": operationID, "state": "unknown", "summary": "本次处理结果暂时无法读取，系统会继续查询。", "receipt": nil}
}
func (s *Service) ExecutePrepared(ctx context.Context, a Actor, proposal Object, operationID string, authorize Authorize) (Object, error) {
	if slices.Contains([]string{"ai-role-command", "ai-work-prompt-save"}, str(proposal["kind"])) {
		if authorize == nil {
			return nil, fail("operations_authorization_unavailable", 503)
		}
		return s.Permissions.ExecuteManagementAction(ctx, a, proposal, operationID, func(ctx context.Context) (Actor, error) { return authorize(ctx, nil) })
	}
	x, command, e := s.proposal(proposal, operationID)
	if e != nil {
		return nil, e
	}
	if authorize == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	purpose := "prepare"
	if s.isDuty(a) {
		purpose = ""
	}
	actor, e := s.human(ctx, a, str(proposal["domain"]), required(x), purpose, authorize)
	if e != nil {
		return nil, e
	}
	// The card callback revalidates a query-purpose proof. Owning writers need
	// a fresh prepare projection, pinned to the exact same fixed AI account.
	// Duty proofs keep their own operation-bound authorization path.
	if !s.isDuty(actor) {
		contextInfo, err := s.Permissions.AIWorkContext(actor)
		if err != nil {
			return nil, err
		}
		accountID := str(contextInfo["accountId"])
		domain := str(proposal["domain"])
		action := required(x)
		prior := authorize
		authorize = func(ctx context.Context, tx pgx.Tx) (Actor, error) {
			current, err := prior(ctx, tx)
			if err != nil {
				return Actor{}, err
			}
			if current.ID != actor.ID || current.Endpoint != actor.Endpoint {
				return Actor{}, fail("business_admin_denied", 403)
			}
			project := func(tx pgx.Tx) (Actor, error) {
				return s.Permissions.HumanAIAccountWithin(ctx, tx, current, domain, accountID, "prepare", action)
			}
			if tx != nil {
				return project(tx)
			}
			return postgres.InTx(ctx, s.Pool, project)
		}
	}
	kind := str(x["kind"])
	if cleanupPlanKind(kind) {
		var exists bool
		if e = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2)`, s.Endpoint, operationID).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return s.RecoverPrepared(ctx, a, proposal, operationID)
		}
		review := preparation{impact: []any{}, basis: []any{}, expires: s.now() + 30}
		if e = s.prepareCleanupPlan(ctx, actor, x, &review); e != nil {
			return nil, e
		}
		frozen := clone(command)
		delete(frozen, "operationId")
		if !same(review.command, frozen) || !same(review.impact, proposal["impact"]) || !same(review.basis, proposal["basis"]) {
			return nil, fail("operations_agentos_review_changed", 409)
		}
	}
	if contentTagKind(kind) {
		var exists bool
		if e = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM business_admin_audit_v1 WHERE endpoint=$1 AND operation_id=$2)`, s.Endpoint, operationID).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return s.RecoverPrepared(ctx, a, proposal, operationID)
		}
		review := preparation{impact: []any{}, basis: []any{}, expires: s.now() + 30}
		if e = s.prepareContentTag(ctx, actor, x, &review); e != nil {
			return nil, e
		}
		frozen := clone(command)
		delete(frozen, "operationId")
		if !same(review.command, frozen) || !same(review.impact, proposal["impact"]) || !same(review.basis, proposal["basis"]) {
			return nil, fail("operations_agentos_review_changed", 409)
		}
	}
	if recommendationExtended(kind) {
		var exists bool
		if e = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND operation_id=$2)`, s.Endpoint, operationID).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return s.RecoverPrepared(ctx, a, proposal, operationID)
		}
		review := preparation{impact: []any{}, basis: []any{}, expires: s.now() + 30}
		if e = s.prepareRecommendationExtended(ctx, actor, x, &review); e != nil {
			return nil, e
		}
		frozen := clone(command)
		delete(frozen, "operationId")
		if !same(review.command, frozen) || !same(review.impact, proposal["impact"]) || !same(review.basis, proposal["basis"]) {
			return nil, fail("operations_agentos_review_changed", 409)
		}
	}
	if noticeKind(kind) {
		var exists bool
		if e = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_product_commands_v1 WHERE endpoint=$1 AND operation_id=$2)`, s.Endpoint, operationID).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return s.RecoverPrepared(ctx, a, proposal, operationID)
		}
		review := preparation{impact: []any{}, basis: []any{}, expires: s.now() + 30}
		if e = s.prepareNotice(ctx, actor, x, operationID, &review); e != nil {
			return nil, e
		}
		frozen := clone(command)
		delete(frozen, "operationId")
		if !same(review.command, frozen) || !same(review.impact, proposal["impact"]) || !same(review.basis, proposal["basis"]) {
			return nil, fail("operations_agentos_review_changed", 409)
		}
	}
	if kind == "search-apply" || kind == "search-restore" || kind == "search-draft-save" || kind == "messaging-state" && (x["action"] == "activate" || x["action"] == "resume") {
		var exists bool
		query := `SELECT EXISTS(SELECT 1 FROM operations_search_quality_operations_v1 WHERE endpoint=$1 AND operation_id=$2)`
		if kind == "messaging-state" {
			query = `SELECT EXISTS(SELECT 1 FROM operations_messaging_commands_v1 WHERE endpoint=$1 AND operation_id=$2)`
		}
		if e = s.Pool.QueryRow(ctx, query, s.Endpoint, operationID).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return s.RecoverPrepared(ctx, a, proposal, operationID)
		}
		review := preparation{impact: []any{}, basis: []any{}, expires: s.now() + 30}
		if kind == "messaging-state" {
			e = s.prepareMessaging(ctx, actor, x, operationID, &review)
		} else {
			e = s.prepareDiscovery(ctx, actor, x, operationID, &review)
		}
		if e != nil {
			return nil, e
		}
		frozen := clone(command)
		delete(frozen, "operationId")
		if !same(review.command, frozen) || !same(review.impact, proposal["impact"]) || !same(review.basis, proposal["basis"]) {
			return nil, fail("operations_agentos_review_changed", 409)
		}
	}
	var result Object
	switch kind {
	case "file-cleanup-plan-create", "file-cleanup-plan-cancel":
		result, e = s.executeCleanupPlan(ctx, actor, x, command)
		if e != nil && fault.Status(e) >= 500 {
			return unknown(operationID), nil
		}
	case "content-tag-create", "content-tag-update":
		result, e = s.executeContentTag(ctx, actor, x, command)
		if e != nil && fault.Status(e) >= 500 {
			return unknown(operationID), nil
		}
	case "recommendation-policy-save", "recommendation-theme-update":
		result, e = s.executeRecommendationExtended(ctx, actor, x, command, authorize)
		if e != nil && fault.Status(e) >= 500 {
			return unknown(operationID), nil
		}
	case "notice-draft-create", "notice-draft-save", "notice-state":
		result, e = s.executeNotice(ctx, actor, x, command)
		if e != nil && fault.Status(e) >= 500 {
			return unknown(operationID), nil
		}
	case "strategy-draft", "strategy-rehearsal", "strategy-publish", "ordinary-strategy-draft", "ordinary-strategy-publish", "strategy-control", "strategy-continue", "rule-publish", "rule-restore":
		result, e = s.executeStrategyRule(ctx, actor, x, command, authorize)
	case "search-draft-save", "search-apply", "search-restore", "recommendation-direction":
		result, e = s.executeDiscovery(ctx, actor, x, command, authorize)
	case "job-cancel", "job-retry", "search-retry":
		service, err := s.jobActions(actor)
		if err != nil {
			return nil, err
		}
		result, e = service.Command(ctx, actor, kind, x, command, authorize)
	case "feedback-update":
		service, err := s.feedback(actor)
		if err != nil {
			return nil, err
		}
		raw, err := protocol.Encode(command)
		if err != nil {
			return nil, err
		}
		result, e = service.Event(ctx, actor, str(x["targetId"]), raw)
		if e != nil && !definiteFeedbackError(fault.Code(e)) {
			return unknownFeedback(operationID), nil
		}
	case "message-draft-create", "message-draft-save", "messaging-state":
		service, err := s.messages(actor)
		if err != nil {
			return nil, err
		}
		switch kind {
		case "message-draft-create":
			result, e = service.CreatePrepared(ctx, actor, pick(command, "operationId", "config"), operationID)
		case "message-draft-save":
			result, e = service.Save(ctx, actor, str(x["targetId"]), command)
		default:
			result, e = service.Action(ctx, actor, str(x["targetId"]), str(x["action"]), command)
		}
	case "account-restriction":
		service, err := s.accounts(actor)
		if err != nil {
			return nil, err
		}
		if x["action"] == "apply" {
			result, e = service.Restrict(ctx, actor, str(x["targetId"]), command)
		} else {
			result, e = service.ReleaseRestriction(ctx, actor, str(x["targetId"]), command)
		}
		if fault.Code(e) == "account_restriction_changed" {
			return nil, fail("operations_agentos_restriction_changed", 409)
		}
		if fault.Code(e) == "invalid_restriction_expiry" {
			return nil, fail("operations_agentos_restriction_deadline", 400)
		}
	case "private-case-message":
		service, err := s.chatReports(actor)
		if err != nil {
			return nil, err
		}
		result, e = service.OperatorMessageVisibility(ctx, actor, pick(x, "reportId", "messageId"), command, func() (Actor, error) {
			return s.human(ctx, actor, str(proposal["domain"]), required(x), purpose, authorize)
		})
	case "section-classification", "section-visibility", "case-resolve":
		service, err := s.content(actor)
		if err != nil {
			return nil, err
		}
		switch kind {
		case "section-classification":
			result, e = service.Classify(ctx, actor, str(x["targetId"]), command)
		case "section-visibility":
			result, e = service.SectionVisibility(ctx, actor, str(x["targetId"]), command)
		case "case-resolve":
			result, e = service.Resolve(ctx, actor, str(x["targetId"]), command)
		}
	case "resource-visibility":
		service, err := s.resources(actor)
		if err != nil {
			return nil, err
		}
		result, e = service.Visibility(ctx, actor, str(x["targetKind"]), str(x["targetId"]), command)
	case "content-visibility", "content-curation", "public-content-batch":
		service, err := s.content(actor)
		if err != nil {
			return nil, err
		}
		switch kind {
		case "content-visibility":
			result, e = service.ContentVisibility(ctx, actor, str(x["targetKind"]), str(x["targetId"]), command)
		case "content-curation":
			result, e = service.Curate(ctx, actor, str(x["targetKind"]), str(x["targetId"]), command)
		case "public-content-batch":
			result, e = service.Batch(ctx, actor, command)
		}
	case "file-scan-retry", "file-access", "file-cleanup-approve":
		service, err := s.files(actor)
		if err != nil {
			return nil, err
		}
		switch kind {
		case "file-scan-retry":
			result, e = service.Retry(ctx, actor, str(x["targetKind"]), str(x["targetId"]), command)
		case "file-access":
			result, e = service.ChangeAccess(ctx, actor, str(x["targetKind"]), str(x["targetId"]), command)
			if e != nil && !slices.Contains([]string{"invalid_operations_request", "business_admin_operation_conflict", "operations_file_changed", "operations_file_access_changed", "operations_file_access_until", "operations_file_access_unavailable", "operations_file_access_restore_unavailable"}, fault.Code(e)) {
				return unknown(operationID), nil
			}
		case "file-cleanup-approve":
			result, e = service.ApproveCleanup(ctx, actor, str(x["planId"]), command)
		}
	}
	if e != nil {
		return nil, e
	}
	result, e = wire(result)
	if e != nil {
		return nil, e
	}
	return actionResult(kind, result, operationID, x, command)
}
func count(v any) any {
	if n, ok := integer(v); ok {
		return n
	}
	return nil
}
func coalesce(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
func safeReceipt(result Object) Object {
	content, plan, run := obj(result["content"]), obj(result["plan"]), obj(result["run"])
	hidden := coalesce(obj(result["visibility"])["hidden"], obj(content["visibility"])["hidden"])
	if _, ok := hidden.(bool); !ok {
		hidden = nil
	}
	state := coalesce(result["state"], plan["state"], run["state"])
	if !slices.Contains([]string{"scheduled", "active", "paused", "stopped", "draft", "resolved", "prepared", "running", "awaiting-human", "completed", "blocked", "no-action", "unknown", "active-for-new-matters"}, str(state)) {
		state = nil
	}
	phase := result["phase"]
	if !slices.Contains([]string{"prepared", "submitting", "task-pending", "applied", "failed", "result-unknown"}, str(phase)) {
		phase = nil
	}
	var op any
	if v, ok := result["operationId"].(string); ok {
		op = v
	}
	return Object{"operationId": op, "publishedVersion": count(result["publishedVersion"]), "version": count(coalesce(result["version"], content["version"], plan["version"])), "revision": count(coalesce(result["revision"], obj(result["visibility"])["version"], obj(content["visibility"])["version"], plan["revision"])), "hidden": hidden, "state": state, "phase": phase, "replayed": result["replayed"] == true}
}
func actionResult(kind string, result Object, operationID string, x, command Object) (Object, error) {
	if cleanupPlanKind(kind) {
		return cleanupPlanResult(kind, result, operationID, x)
	}
	if contentTagKind(kind) {
		return contentTagResult(kind, result, operationID, x)
	}
	if recommendationExtended(kind) {
		return recommendationExtendedResult(kind, result, operationID, x, command)
	}
	if noticeKind(kind) {
		return noticeResult(kind, result, operationID, x)
	}
	if strategyRuleKind(kind) {
		return strategyRuleResult(kind, result, operationID, x)
	}
	if kind == "search-draft-save" || kind == "search-apply" || kind == "search-restore" || kind == "recommendation-direction" {
		return discoveryResult(kind, result, operationID, x, command, false)
	}
	if kind == "job-cancel" || kind == "job-retry" || kind == "search-retry" {
		return jobsResult(kind, result, operationID, x, command)
	}
	if kind == "feedback-update" {
		return feedbackResult(result, operationID, x, command, false)
	}
	if kind == "message-draft-create" || kind == "message-draft-save" {
		return messageDraftResult(kind, result, operationID, x, command, false)
	}
	if kind == "account-restriction" {
		r := obj(result["restriction"])
		_, ok := integer(r["revision"])
		_, active := r["active"].(bool)
		release := x["action"] == "release"
		at, err := time.Parse(time.RFC3339Nano, str(r["until"]))
		expected, e := time.Parse(time.RFC3339Nano, str(x["until"]))
		if result["accountId"] != x["targetId"] || result["operationId"] != operationID || r["scope"] != "community-participation" || !ok || !active || release && (r["until"] != nil || r["active"] != false) || !release && (err != nil || e != nil || !at.Equal(expected)) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		summary := "已解除这次确认的参与限制。"
		if !release {
			summary = "已设置参与限制，截止北京时间 " + restrictedTime(at.Unix()) + "。"
		}
		return Object{"operationId": operationID, "state": "completed", "summary": summary, "receipt": Object{"operationId": operationID, "accountId": result["accountId"], "revision": r["revision"], "restriction": pick(r, "scope", "active", "until"), "replayed": result["replayed"] == true}}, nil
	}
	if kind == "private-case-message" {
		var selected Object
		for _, v := range items(result["materials"]) {
			if obj(v)["messageId"] == x["messageId"] {
				selected = obj(v)
				break
			}
		}
		op := obj(result["messageOperation"])
		revision := coalesce(op["revision"], obj(selected["moderation"])["revision"], result["revision"])
		version := coalesce(op["reportVersion"], result["version"])
		id := coalesce(op["operationId"], result["operationId"])
		if id != operationID || coalesce(result["reportId"], x["reportId"]) != x["reportId"] || num(revision) != num(command["expectedRevision"])+1 || num(version) != num(command["expectedVersion"])+1 {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		return Object{"operationId": operationID, "state": "completed", "summary": "本案所选消息处理已记录。", "receipt": Object{"operationId": operationID, "reportId": x["reportId"], "messageId": x["messageId"], "sourceRevision": command["messageRevision"], "version": version, "revision": revision, "action": x["action"], "ownHidden": x["action"] != "restore", "replayed": result["replayed"] == true || op["replayed"] == true}}, nil
	}
	receipt := safeReceipt(result)
	summary := "本次处理已完成。"
	state := "completed"
	if kind == "public-content-batch" {
		rows, selected := items(result["items"]), items(command["items"])
		if result["operationId"] != operationID || rows == nil || len(rows) != len(selected) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		applied := 0
		out := []any{}
		for i, v := range rows {
			r := obj(v)
			if r["id"] != obj(selected[i])["id"] || r["kind"] != obj(selected[i])["kind"] || !slices.Contains([]string{"applied", "rejected"}, str(r["status"])) {
				return nil, fail("operations_agentos_operation_conflict", 409)
			}
			if r["status"] == "applied" {
				applied++
			}
			out = append(out, Object{"kind": r["kind"], "id": r["id"], "status": r["status"], "code": r["code"], "revision": obj(r["visibility"])["version"]})
		}
		if applied == 0 {
			state = "failed"
		}
		return Object{"operationId": operationID, "state": state, "summary": fmt.Sprintf("这批公开内容已处理 %d 项，未处理 %d 项。", applied, len(rows)-applied), "receipt": Object{"operationId": operationID, "counts": Object{"applied": applied, "rejected": len(rows) - applied}, "items": out, "replayed": result["replayed"] == true}}, nil
	}
	if kind == "content-curation" {
		value := obj(result["content"])
		if value == nil {
			value = result
		}
		version, revision := coalesce(obj(result["content"])["version"], result["sourceVersion"]), coalesce(obj(obj(result["content"])["curation"])["revision"], result["revision"])
		if value["kind"] != x["targetKind"] || value["id"] != x["targetId"] || count(version) == nil || count(revision) == nil || num(revision) < 1 || result["operationId"] != nil && result["operationId"] != operationID {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		receipt["operationId"], receipt["version"], receipt["revision"], receipt["hidden"] = operationID, version, revision, nil
	}
	if kind == "file-access" {
		stop := x["action"] == "stop"
		if result["operationId"] != operationID || result["kind"] != x["targetKind"] || result["id"] != x["targetId"] || result["action"] != x["action"] || count(result["revision"]) == nil || num(result["revision"]) < 1 || result["stopped"] != stop || stop && !same(result["until"], x["until"]) || !stop && result["until"] != nil {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		summary = "已解除这次确认的运营访问覆盖。"
		if stop {
			summary = "已设置停止访问，截止北京时间 " + restrictedTime(num(result["until"])) + "。"
		}
		return Object{"operationId": operationID, "state": "completed", "summary": summary, "receipt": Object{"operationId": operationID, "kind": result["kind"], "id": result["id"], "action": result["action"], "revision": result["revision"], "stopped": result["stopped"], "until": result["until"], "replayed": receipt["replayed"]}}, nil
	}
	if kind == "file-cleanup-approve" {
		plan := obj(result["plan"])
		phase := str(plan["state"])
		if result["kind"] != "approve" || !validID(result["planId"]) || !slices.Contains([]string{"queued", "running", "completed", "attention", "cancelled"}, phase) {
			return nil, fail("operations_agentos_operation_conflict", 409)
		}
		summary = "已批准这份计划，系统会逐项核对并清理。"
		switch phase {
		case "completed":
			summary = "这份清理计划已批准，逐项处理已结束；对象移除结果可在计划中查看。"
		case "attention":
			summary = "这份清理计划已批准，部分对象的结果尚未确认，请查看计划。"
		case "cancelled":
			summary = "这份计划曾获批准，后续清理已取消。"
		}
		receipt["planId"], receipt["state"] = result["planId"], phase
		return Object{"operationId": operationID, "state": "completed", "summary": summary, "receipt": receipt}, nil
	}
	if kind == "file-scan-retry" {
		summary = "已重新安排扫描，等待扫描结果。"
	}
	return Object{"operationId": operationID, "state": state, "summary": summary, "receipt": receipt}, nil
}
