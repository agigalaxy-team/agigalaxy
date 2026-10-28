package operationsaudit

import (
	"context"
	"slices"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func equal(a, b any) bool {
	x, e := protocol.EncodeJS([]any{a})
	y, f := protocol.EncodeJS([]any{b})
	return e == nil && f == nil && string(x) == string(y)
}
func unique(values []string) []string {
	o := []string{}
	seen := map[string]bool{}
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			o = append(o, v)
		}
	}
	return o
}
func validIDs(values []string) []string {
	o := []string{}
	for _, v := range unique(values) {
		if validFormat(v, "uuid") {
			o = append(o, v)
		}
	}
	return o
}
func (s *Service) permissionLinks(ctx context.Context, input []Object) []Object {
	found := []Object{}
	operations := []string{}
	for _, row := range input {
		if row["action"] != "permission-assignment-save" {
			continue
		}
		selection := Object{}
		for k, v := range obj(row["selection"]) {
			if k != "targetOperatorId" && k != "roleId" {
				selection[k] = v
			}
		}
		row["selection"] = selection
		if row["endpoint"] == s.Domain.Endpoint && row["actor_kind"] == "business-operator" && validFormat(row["id"], "uuid") && validFormat(row["operation_id"], "uuid") && matchPattern(`^[0-9a-f]{64}$`, str(row["operator_id"])) && validFormat(selection["resourceId"], "uuid") {
			found = append(found, row)
			operations = append(operations, str(row["operation_id"]))
		}
	}
	if len(found) == 0 {
		return input
	}
	tx, e := s.Domain.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if e != nil {
		return input
	}
	defer tx.Rollback(context.Background())
	events, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM operations_permission_events_v1 e WHERE endpoint=$1 AND id=ANY($2::uuid[]) AND kind='assignment-save'", s.Domain.Endpoint, unique(operations))
	if e != nil {
		return input
	}
	if tx.Commit(ctx) != nil {
		return input
	}
	for _, row := range found {
		for _, event := range events {
			if event["id"] != row["operation_id"] || event["operator_id"] != row["operator_id"] || str(event["resource_id"]) != strings.ToLower(str(obj(row["selection"])["resourceId"])) {
				continue
			}
			in, out := obj(event["input"]), obj(event["result"])
			assignment := obj(out["assignment"])
			version, _ := numeric(event["version"])
			if !matchPattern(`^[0-9a-f]{64}$`, str(in["operatorId"])) || !validFormat(in["roleId"], "uuid") || strings.ToLower(str(in["operationId"])) != str(event["id"]) || strings.ToLower(str(out["operationId"])) != str(event["id"]) {
				continue
			}
			if id, present := in["id"]; present && strings.ToLower(str(id)) != str(event["resource_id"]) {
				continue
			}
			if !equal(in["expectedVersion"], version-1) || !equal(obj(row["selection"])["expectedVersion"], in["expectedVersion"]) || assignment["id"] != event["resource_id"] || assignment["operatorId"] != in["operatorId"] || assignment["roleId"] != strings.ToLower(str(in["roleId"])) || !equal(assignment["version"], event["version"]) || !equal(obj(row["result"])["version"], event["version"]) {
				continue
			}
			enabled, ok := in["enabled"].(bool)
			if !ok || assignment["enabled"] != enabled || obj(row["result"])["enabled"] != enabled {
				continue
			}
			obj(row["selection"])["targetOperatorId"], obj(row["selection"])["roleId"] = in["operatorId"], strings.ToLower(str(in["roleId"]))
		}
	}
	return input
}
func (s *Service) decorate(ctx context.Context, input []Object, canReadTasks bool) ([]Object, error) {
	input = s.permissionLinks(ctx, input)
	if len(input) == 0 {
		return input, nil
	}
	endpoint := s.Domain.Endpoint
	contexts := map[string]Object{}
	operations, calls := []string{}, []string{}
	for _, row := range input {
		if validFormat(row["operation_id"], "uuid") {
			operations = append(operations, str(row["operation_id"]))
		}
		if parsed, ok := validate(row["actor_context"], catalog.ActorContext); ok {
			context := obj(parsed)
			if row["actor_kind"] == "operations-ai-service" && row["operator_id"] == "ai:"+str(context["aiAccountId"]) {
				contexts[str(row["id"])] = context
				if context["toolCallId"] != nil {
					calls = append(calls, str(context["toolCallId"]))
				}
			}
		}
	}
	operations = unique(operations)
	calls = unique(calls)
	query := func(sql string, ids []string) ([]Object, error) {
		if len(ids) == 0 {
			return []Object{}, nil
		}
		return rows(ctx, s.Domain.Pool, sql, endpoint, ids)
	}
	duties, e := query("SELECT to_jsonb(d) FROM (SELECT operation_id,task_id,ai_account_id FROM operations_ai_duty_operations_v1 WHERE endpoint=$1 AND operation_id=ANY($2::uuid[])) d", operations)
	if e != nil {
		return nil, e
	}
	cards, e := query(`SELECT to_jsonb(c) FROM (SELECT id,operator_id,operation_id,turn_id,CASE WHEN jsonb_typeof(result->'confirmationAttemptedAt')='string' THEN result->>'confirmationAttemptedAt' ELSE NULL END AS confirmed_at FROM operations_agentos_conversation_cards_v1 WHERE endpoint=$1 AND operation_id=ANY($2::uuid[])) c`, operations)
	if e != nil {
		return nil, e
	}
	runs, e := query(`SELECT to_jsonb(x) FROM (SELECT r.task_id,r.turn_operation_id FROM operations_autonomy_workbench_runs_v1 r JOIN operations_agentos_conversation_cards_v1 c ON c.endpoint=r.endpoint AND c.turn_id=r.turn_operation_id WHERE r.endpoint=$1 AND c.operation_id=ANY($2::uuid[])) x`, operations)
	if e != nil {
		return nil, e
	}
	toolCalls, e := query("SELECT to_jsonb(x) FROM (SELECT task_id,call_id,operation_id FROM operations_autonomy_tool_calls_v1 WHERE endpoint=$1 AND call_id=ANY($2::uuid[])) x", calls)
	if e != nil {
		return nil, e
	}
	taskIDs := []string{}
	for _, c := range contexts {
		taskIDs = append(taskIDs, str(c["taskId"]))
	}
	for _, d := range duties {
		taskIDs = append(taskIDs, str(d["task_id"]))
	}
	for _, c := range cards {
		taskIDs = append(taskIDs, str(c["turn_id"]))
	}
	for _, r := range runs {
		taskIDs = append(taskIDs, str(r["task_id"]))
	}
	tasks, e := query(`SELECT to_jsonb(t) FROM (SELECT id,ai_account_id,domain,source,configuration#>>'{externalWorkbench,operatorId}' AS initiator_id FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])) t`, validIDs(taskIDs))
	if e != nil {
		return nil, e
	}
	aiIDs, initiators := []string{}, []string{}
	for _, row := range input {
		if strings.HasPrefix(str(row["operator_id"]), "ai:") {
			aiIDs = append(aiIDs, strings.TrimPrefix(str(row["operator_id"]), "ai:"))
		}
	}
	for _, task := range tasks {
		aiIDs = append(aiIDs, str(task["ai_account_id"]))
		if id, ok := task["initiator_id"].(string); ok && protocol.TextLength(id) <= 1024 {
			initiators = append(initiators, id)
		}
	}
	accounts, e := query("SELECT to_jsonb(a) FROM (SELECT id,domain,name FROM operations_ai_work_accounts_v1 WHERE endpoint=$1 AND id=ANY($2::uuid[])) a", validIDs(aiIDs))
	if e != nil {
		return nil, e
	}
	people := []Object{}
	if len(initiators) > 0 {
		people, e = rows(ctx, s.Domain.Pool, "SELECT to_jsonb(p) FROM (SELECT operator_id,display_name FROM operations_operator_principals_v1 WHERE endpoint=$1 AND operator_id=ANY($2::text[])) p", endpoint, unique(initiators))
		if e != nil {
			return nil, e
		}
	}
	for _, row := range input {
		attribution := baseAttribution(row)
		context := contexts[str(row["id"])]
		human := row["actor_kind"] == "business-operator"
		var duty, card, task Object
		for _, v := range duties {
			if v["operation_id"] == row["operation_id"] && row["actor_kind"] == "operations-ai-service" && row["operator_id"] == "ai:"+str(v["ai_account_id"]) {
				duty = v
				break
			}
		}
		for _, v := range cards {
			if v["operation_id"] == row["operation_id"] && human && v["operator_id"] == row["operator_id"] {
				card = v
				break
			}
		}
		for _, v := range tasks {
			match := false
			if context != nil {
				match = v["id"] == context["taskId"] && v["ai_account_id"] == context["aiAccountId"] && v["domain"] == context["domain"]
			} else if duty != nil {
				match = v["id"] == duty["task_id"] && v["ai_account_id"] == duty["ai_account_id"]
			} else if card != nil {
				linked := v["id"] == card["turn_id"]
				for _, r := range runs {
					linked = linked || r["task_id"] == v["id"] && r["turn_operation_id"] == card["turn_id"]
				}
				match = linked && v["initiator_id"] == card["operator_id"]
			}
			if match {
				task = v
				break
			}
		}
		aiID := attribution["aiAccountId"]
		if aiID == nil {
			aiID = task["ai_account_id"]
		}
		for _, account := range accounts {
			if account["id"] == aiID {
				attribution["aiAccountId"], attribution["aiAccountName"] = account["id"], cleanName(account["name"])
				if slices.Contains([]string{"overview", "governance", "messaging", "discovery", "maintenance"}, str(account["domain"])) {
					attribution["domain"] = account["domain"]
				}
				break
			}
		}
		if context != nil {
			for _, key := range []string{"planId", "planVersion", "grantId", "grantVersion", "strategyId", "strategyVersionId"} {
				if context[key] != nil {
					attribution[key] = context[key]
				}
			}
		}
		if task != nil {
			attribution["taskId"], attribution["taskSource"], attribution["taskReadable"] = task["id"], task["source"], canReadTasks
			if task["source"] == "workbench" && task["initiator_id"] != nil && task["initiator_id"] != "" {
				attribution["initiatorKind"], attribution["initiatorOperatorId"] = "human", task["initiator_id"]
				var name any
				for _, p := range people {
					if p["operator_id"] == task["initiator_id"] {
						name = cleanName(p["display_name"])
						break
					}
				}
				attribution["initiatorDisplayName"] = name
			} else if !human {
				source := map[string]string{"routine": "schedule", "event": "business-event", "recovery": "recovery"}[str(task["source"])]
				if source == "" {
					source = "unknown"
				}
				attribution["initiatorKind"] = source
			}
		}
		if card != nil && stamp(card["confirmed_at"]) != nil {
			attribution["cardId"], attribution["decisionSource"], attribution["decisionBasis"] = card["id"], "human-confirmed", "confirmed-operation-card"
		}
		if context["judgmentKind"] != nil && task != nil {
			for _, call := range toolCalls {
				if call["task_id"] == task["id"] && call["call_id"] == context["toolCallId"] && call["operation_id"] == context["toolOperationId"] {
					attribution["decisionSource"] = context["judgmentKind"]
					basis := "server-rule"
					if context["judgmentKind"] == "ai" {
						basis = "verified-native-tool"
					}
					attribution["decisionBasis"] = basis
					break
				}
			}
		}
		parsed, ok := validate(attribution, catalog.Attribution)
		if !ok {
			return nil, fail("audit_attribution_unavailable", 503)
		}
		row["audit_attribution"] = parsed
	}
	return input, nil
}
func scalarValues(value any) []string {
	out := []string{}
	switch v := value.(type) {
	case []any:
		for _, x := range v {
			out = append(out, scalarValues(x)...)
		}
	case map[string]any:
		for _, x := range v {
			out = append(out, scalarValues(x)...)
		}
	case string:
		out = append(out, v)
	case bool:
		if v {
			out = append(out, "true")
		} else {
			out = append(out, "false")
		}
	default:
		if _, ok := numeric(v); ok {
			out = append(out, stringValue(v))
		}
	}
	return out
}
func matchesQuery(item, q Object, snapshot bool) bool {
	if resource := str(q["resourceId"]); resource != "" {
		keys := strings.Fields("resourceId id sectionId reportId projectId methodId fileId feedbackId noticeId runId jobId planId modelRecordId roleId versionId")
		if snapshot {
			keys = append(keys, "registrationId")
		}
		match := false
		for _, key := range keys {
			match = match || strings.EqualFold(str(obj(item["selection"])[key]), resource)
		}
		for _, key := range []string{"taskId", "cardId"} {
			match = match || strings.EqualFold(str(obj(item["attribution"])[key]), resource)
		}
		if !match {
			return false
		}
	}
	needle := cases.Lower(language.SimplifiedChinese).String(str(q["query"]))
	if needle != "" {
		for _, value := range scalarValues(item) {
			if strings.Contains(cases.Lower(language.SimplifiedChinese).String(value), needle) {
				return true
			}
		}
		return false
	}
	return true
}
