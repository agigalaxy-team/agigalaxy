package messaging

import (
	"context"
	"strconv"
)

var recipientStates = []string{"pending", "submitting", "submitted", "delivered", "skipped", "failed", "unknown", "blocked"}

func audienceAvailability() Object {
	return Object{"source": "configured-business-database", "availableAttributes": []any{"subject-type"}, "unavailableAttributes": []any{"level", "honor"}, "organizationScope": "account-only", "upstreamDirectoryAudience": "not-connected"}
}
func approval(row Object) Object {
	kind := "business-operator"
	if row["approved_ai"] != nil {
		kind = "operations-ai-service"
	}
	value := Object{"kind": kind, "operatorId": row["approved_by"], "role": row["approved_role"]}
	if metadata := obj(row["approved_ai"]); metadata != nil {
		value["aiAccountId"] = metadata["aiAccountId"]
		value["domain"] = metadata["domain"]
		value["taskId"] = metadata["taskId"]
		value["operationId"] = obj(metadata["operation"])["operationId"]
	}
	return value
}
func (s *Service) planView(row Object, actor Actor) Object {
	state := str(row["state"])
	config := obj(row["config"])
	content, schedule := obj(config["content"]), obj(config["schedule"])
	expires, _ := date(content["expiresAt"])
	expired := state != "stopped" && !expires.After(s.now())
	effective := state
	if expired {
		effective = "expired"
	}
	var approved any
	if row["approved_by"] != nil {
		value := approval(row)
		value["at"] = stamp(row["approved_at"])
		approved = value
	}
	var scheduled any
	if str(schedule["kind"]) == "once" {
		scheduled = schedule["at"]
	}
	return Object{"id": row["id"], "sequence": str(row["sequence"]), "version": row["version"], "revision": row["revision"], "state": state, "effectiveState": effective, "config": row["config"], "audienceAvailability": audienceAvailability(), "createdBy": row["created_by"], "updatedBy": row["updated_by"], "createdAt": stamp(row["created_at"]), "updatedAt": stamp(row["updated_at"]), "approval": approved, "scheduling": Object{"engine": "river", "missed": "skip", "scheduledAt": scheduled, "occurrenceTimeRecorded": false}, "capabilities": Object{"canSave": has(actor, "notices.update") && state != "active", "canActivate": has(actor, "notices.publish") && state == "draft" && !expired, "canPause": has(actor, "notices.withdraw") && state == "active" && !expired, "canResume": has(actor, "notices.publish") && state == "paused" && !expired, "canStop": has(actor, "notices.withdraw") && contains([]string{"active", "paused"}, state), "canWithdraw": has(actor, "notices.withdraw")}, "jobId": row["job_id"]}
}
func deliveryCounts(rows []Object) Object {
	out := Object{}
	for _, channel := range []string{"inapp", "email"} {
		values := Object{"total": int64(0)}
		for _, state := range recipientStates {
			values[state] = int64(0)
		}
		out[channel] = values
	}
	for _, row := range rows {
		channel, state := str(row["channel"]), str(row["state"])
		if !contains([]string{"inapp", "email"}, channel) || !contains(recipientStates, state) {
			continue
		}
		values := obj(out[channel])
		n := num(row["count"])
		values[state] = num(values[state]) + n
		values["total"] = num(values["total"]) + n
	}
	email := obj(out["email"])
	for _, key := range []string{"delivered", "bounced", "opened", "clicked"} {
		email[key] = nil
	}
	email["receipts"] = "not-connected"
	return out
}
func (s *Service) runView(ctx context.Context, db Reader, row Object) (Object, error) {
	rows, e := many(ctx, db, `SELECT jsonb_build_object('channel',channel,'state',state,'count',count(*)::integer) FROM operations_messaging_recipients_v1 WHERE run_id=$1 GROUP BY channel,state`, row["id"])
	if e != nil {
		return nil, e
	}
	announcements, e := many(ctx, db, `SELECT to_jsonb(a) FROM operations_messaging_announcements_v1 a WHERE run_id=$1`, row["id"])
	if e != nil {
		return nil, e
	}
	announcement := Object{"id": nil, "state": "not-published", "audience": "public", "publishedAt": nil, "expiresAt": nil, "withdrawnAt": nil}
	if len(announcements) > 0 {
		value := announcements[0]
		state := "published"
		expires, _ := date(value["expires_at"])
		if value["withdrawn_at"] != nil {
			state = "withdrawn"
		} else if !expires.After(s.now()) {
			state = "expired"
		}
		announcement = Object{"id": value["id"], "state": state, "audience": "public", "publishedAt": stamp(value["published_at"]), "expiresAt": stamp(value["expires_at"]), "withdrawnAt": stamp(value["withdrawn_at"])}
	}
	return Object{"id": row["id"], "sequence": str(row["sequence"]), "planId": row["plan_id"], "planVersion": row["plan_version"], "revision": row["revision"], "state": row["state"], "occurrenceId": row["occurrence_key"], "scheduledAt": nil, "createdAt": stamp(row["created_at"]), "updatedAt": stamp(row["updated_at"]), "completedAt": stamp(row["completed_at"]), "audience": Object{"accountCount": row["audience_count"], "frozenAt": stamp(row["frozen_at"]), "additionalTargetsAllowed": false}, "approval": approval(row), "delivery": deliveryCounts(rows), "errorCode": row["error_code"], "jobId": row["job_id"], "announcement": announcement}, nil
}
func (s *Service) recipientView(ctx context.Context, db Reader, row Object) (Object, error) {
	accounts, e := many(ctx, db, `SELECT jsonb_build_object('id',a.id,'uid',a.uid,'subject_type',p.subject_type,'display_name',p.display_name) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`, row["account_id"], s.Endpoint)
	if e != nil {
		return nil, e
	}
	account := Object{"accountId": row["account_id"], "uid": nil, "subjectType": nil, "displayName": nil, "state": "unavailable"}
	if len(accounts) > 0 {
		value := accounts[0]
		account = Object{"accountId": row["account_id"], "uid": value["uid"], "subjectType": value["subject_type"], "displayName": value["display_name"], "state": "available"}
	}
	attempts, e := many(ctx, db, `SELECT to_jsonb(a) FROM operations_messaging_attempts_v1 a WHERE recipient_id=$1 ORDER BY attempt_number`, row["id"])
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, attempt := range attempts {
		items = append(items, Object{"id": attempt["id"], "number": attempt["attempt_number"], "state": attempt["state"], "networkAttempt": !contains([]string{"smtp_rate_limited", "smtp_concurrency_limited"}, str(attempt["error_code"])), "errorCode": attempt["error_code"], "startedAt": stamp(attempt["started_at"]), "finishedAt": stamp(attempt["finished_at"])})
	}
	return Object{"id": row["id"], "sequence": str(row["sequence"]), "account": account, "channel": row["channel"], "state": row["state"], "attemptCount": row["attempt_count"], "deferred": str(row["state"]) == "pending" && row["retry_at"] != nil && contains([]string{"smtp_rate_limited", "smtp_concurrency_limited"}, str(row["error_code"])), "errorCode": row["error_code"], "retryable": boolValue(row["retryable"]), "messageId": row["message_id"], "leaseUntil": stamp(row["lease_until"]), "retryAt": stamp(row["retry_at"]), "submittedAt": stamp(row["submitted_at"]), "completedAt": stamp(row["completed_at"]), "attempts": items}, nil
}
func decimal(value int64) string { return strconv.FormatInt(value, 10) }
