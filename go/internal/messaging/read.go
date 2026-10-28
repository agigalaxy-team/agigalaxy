package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strconv"
)

type page struct {
	after                  any
	limit                  int
	state, channel, planID any
}

func parsePage(input Object, extra ...string) (page, error) {
	q := page{limit: 30}
	allowed := append([]string{"after", "limit"}, extra...)
	if !keys(input, allowed...) {
		return q, invalidInput()
	}
	if value, ok := input["after"]; ok {
		s, ok := value.(string)
		if !ok || !regexp.MustCompile(`^[1-9][0-9]{0,18}$`).MatchString(s) {
			return q, invalidInput()
		}
		if _, e := strconv.ParseInt(s, 10, 64); e != nil {
			return q, invalidInput()
		}
		q.after = s
	}
	if value, ok := input["limit"]; ok {
		if !intOK(value, 1, 100) {
			return q, invalidInput()
		}
		q.limit = int(num(value))
	}
	q.state = input["state"]
	q.channel = input["channel"]
	q.planID = input["planId"]
	return q, nil
}
func (s *Service) read(ctx context.Context, a Actor, fn func(pgx.Tx, Actor) (Object, error)) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.require(ctx, tx, a, "notices.read")
		if e != nil {
			return nil, e
		}
		result, e := fn(tx, actor)
		if e != nil {
			return nil, e
		}
		if _, e = s.require(ctx, tx, a, "notices.read"); e != nil {
			return nil, e
		}
		return result, nil
	})
}
func cutPage(rows []Object, limit int) ([]Object, any) {
	var next any
	if len(rows) > limit {
		next = str(rows[limit-1]["sequence"])
		rows = rows[:limit]
	}
	return rows, next
}
func (s *Service) audienceAccounts(ctx context.Context, db Reader, config Object) (Object, error) {
	audience := obj(config["audience"])
	if str(audience["kind"]) != "accounts" {
		return Object{"state": "not-applicable", "items": []any{}}, nil
	}
	ids := list(audience["accountIds"])
	rows, e := many(ctx, db, `SELECT jsonb_build_object('id',a.id,'uid',a.uid,'displayName',p.display_name) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.endpoint=$1 AND a.id=ANY($2::uuid[])`, s.Endpoint, ids)
	if e != nil {
		return nil, e
	}
	found := map[string]Object{}
	for _, row := range rows {
		found[str(row["id"])] = row
	}
	items := []any{}
	for _, id := range ids {
		item := Object{"accountId": id, "uid": nil, "displayName": nil, "state": "unavailable"}
		if row := found[id]; row != nil {
			item["uid"] = row["uid"]
			item["displayName"] = row["displayName"]
			item["state"] = "available"
		}
		items = append(items, item)
	}
	return Object{"state": "available", "items": items}, nil
}
func (s *Service) historyWithin(ctx context.Context, db Reader, id string, input Object) (Object, error) {
	q, e := parsePage(input)
	if e != nil {
		return nil, e
	}
	rows, e := many(ctx, db, `SELECT to_jsonb(e)||jsonb_build_object('operator_display_name',COALESCE(NULLIF(BTRIM(o.display_name),''),a.name)) FROM operations_messaging_events_v1 e JOIN operations_messaging_plans_v1 p ON p.id=e.plan_id AND p.endpoint=$4 LEFT JOIN operations_operator_principals_v1 o ON o.operator_id=e.operator_id AND o.endpoint=p.endpoint LEFT JOIN operations_ai_work_accounts_v1 a ON a.id::text=e.ai_context->>'aiAccountId' AND a.endpoint=p.endpoint WHERE e.plan_id=$1 AND ($2::bigint IS NULL OR e.sequence<$2) ORDER BY e.sequence DESC LIMIT $3`, id, q.after, q.limit+1, s.Endpoint)
	if e != nil {
		return nil, e
	}
	rows, next := cutPage(rows, q.limit)
	items := []any{}
	for _, row := range rows {
		ai := obj(row["ai_context"])
		items = append(items, Object{"id": row["id"], "sequence": str(row["sequence"]), "operatorId": row["operator_id"], "operatorDisplayName": row["operator_display_name"], "operatorRole": row["operator_role"], "actorKind": row["actor_kind"], "aiAccountId": ai["aiAccountId"], "taskId": ai["taskId"], "kind": row["kind"], "version": row["version"], "revision": row["revision"], "createdAt": stamp(row["created_at"])})
	}
	return Object{"items": items, "nextAfter": next}, nil
}
func (s *Service) Get(ctx context.Context, a Actor, id string) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, actor Actor) (Object, error) {
		row, e := s.planWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		history, e := s.historyWithin(ctx, tx, id, Object{"limit": 30})
		if e != nil {
			return nil, e
		}
		runs, e := many(ctx, tx, "SELECT to_jsonb(r) FROM operations_messaging_runs_v1 r WHERE plan_id=$1 ORDER BY sequence DESC LIMIT 10", id)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, run := range runs {
			view, e := s.runView(ctx, tx, run)
			if e != nil {
				return nil, e
			}
			items = append(items, view)
		}
		audience, e := s.audienceAccounts(ctx, tx, obj(row["config"]))
		if e != nil {
			return nil, e
		}
		return Object{"plan": s.planView(row, actor), "history": history, "audienceAccounts": audience, "recentRuns": items, "sender": s.senderStatusWithin(ctx, tx), "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30}, nil
	})
}
func (s *Service) History(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		if _, e := s.planWithin(ctx, tx, id, false); e != nil {
			return nil, e
		}
		result, e := s.historyWithin(ctx, tx, id, input)
		if e != nil {
			return nil, e
		}
		result["checkedAt"] = s.now().Unix()
		result["readExpiresAt"] = s.now().Unix() + 30
		result["metadataOnly"] = true
		return result, nil
	})
}
func (s *Service) Run(ctx context.Context, a Actor, id string) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, actor Actor) (Object, error) {
		row, e := s.runWithin(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		head, e := s.planWithin(ctx, tx, str(row["plan_id"]), false)
		if e != nil {
			return nil, e
		}
		var eligible int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM operations_messaging_recipients_v1 WHERE run_id=$1 AND (state='blocked' OR state='failed' AND retryable) AND attempt_count<$2`, id, maxSubmitAttempts).Scan(&eligible); e != nil {
			return nil, e
		}
		expires, _ := date(obj(obj(row["config"])["content"])["expiresAt"])
		view, e := s.runView(ctx, tx, row)
		if e != nil {
			return nil, e
		}
		return Object{"run": view, "config": row["config"], "audienceAvailability": audienceAvailability(), "capabilities": Object{"canRetry": has(actor, "notices.publish") && str(head["state"]) == "active" && num(head["version"]) == num(row["plan_version"]) && expires.After(s.now()) && eligible > 0}, "retryPolicy": Object{"maxSubmitAttempts": maxSubmitAttempts, "retryDelaySeconds": 30, "retryDelayMaxSeconds": 900, "submissionLeaseSeconds": 300, "pageSize": deliveryPageSize, "unknownResultsRetryable": false}, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30}, nil
	})
}
func (s *Service) Runs(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parsePage(input, "planId")
	if e != nil {
		return nil, e
	}
	if q.planID != nil && !uuidOK(q.planID) {
		return nil, invalidInput()
	}
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		rows, e := many(ctx, tx, `SELECT to_jsonb(r) FROM operations_messaging_runs_v1 r WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) AND ($3::uuid IS NULL OR plan_id=$3) ORDER BY sequence DESC LIMIT $4`, s.Endpoint, q.after, q.planID, q.limit+1)
		if e != nil {
			return nil, e
		}
		rows, next := cutPage(rows, q.limit)
		items := []any{}
		for _, run := range rows {
			view, e := s.runView(ctx, tx, run)
			if e != nil {
				return nil, e
			}
			items = append(items, view)
		}
		return Object{"items": items, "nextAfter": next, "metadataOnly": true, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30}, nil
	})
}
func (s *Service) Recipients(ctx context.Context, a Actor, runID string, input Object) (Object, error) {
	q, e := parsePage(input, "channel", "state")
	if e != nil {
		return nil, e
	}
	if q.channel != nil && !contains([]string{"inapp", "email"}, str(q.channel)) || q.state != nil && !contains(recipientStates, str(q.state)) {
		return nil, invalidInput()
	}
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		if _, e := s.runWithin(ctx, tx, runID, false); e != nil {
			return nil, e
		}
		rows, e := many(ctx, tx, `SELECT to_jsonb(r) FROM operations_messaging_recipients_v1 r WHERE run_id=$1 AND ($2::bigint IS NULL OR sequence>$2) AND ($3::text IS NULL OR channel=$3) AND ($4::text IS NULL OR state=$4) ORDER BY sequence LIMIT $5`, runID, q.after, q.channel, q.state, q.limit+1)
		if e != nil {
			return nil, e
		}
		rows, next := cutPage(rows, q.limit)
		items := []any{}
		for _, row := range rows {
			view, e := s.recipientView(ctx, tx, row)
			if e != nil {
				return nil, e
			}
			items = append(items, view)
		}
		return Object{"items": items, "nextAfter": next, "metadataOnly": true, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30}, nil
	})
}

func (s *Service) senderStatusWithin(ctx context.Context, db Reader) Object {
	if s.Mail != nil {
		if current, e := s.Mail.current(ctx, db); e == nil {
			status := s.Mail.status(current)
			return Object{"state": status["state"], "enabled": status["enabled"], "configVersion": status["configVersion"], "receipts": "not-connected"}
		}
	}
	return Object{"state": "not-configured", "enabled": false, "configVersion": nil, "receipts": "not-connected"}
}
func groupCounts(rows []Object, states []string) Object {
	result := Object{"total": int64(0)}
	for _, state := range states {
		result[state] = int64(0)
	}
	for _, row := range rows {
		state := str(row["state"])
		if contains(states, state) {
			result[state] = row["count"]
			result["total"] = num(result["total"]) + num(row["count"])
		}
	}
	return result
}
func (s *Service) overview(ctx context.Context, db Reader, state any) (Object, error) {
	plans, e := many(ctx, db, `SELECT jsonb_build_object('state',state,'count',count(*)::integer) FROM operations_messaging_plans_v1 WHERE endpoint=$1 AND ($2::text IS NULL OR state=$2) GROUP BY state`, s.Endpoint, state)
	if e != nil {
		return nil, e
	}
	runs, e := many(ctx, db, `SELECT jsonb_build_object('state',r.state,'count',count(*)::integer) FROM operations_messaging_runs_v1 r JOIN operations_messaging_plans_v1 p ON p.id=r.plan_id WHERE r.endpoint=$1 AND ($2::text IS NULL OR p.state=$2) GROUP BY r.state`, s.Endpoint, state)
	if e != nil {
		return nil, e
	}
	recipients, e := many(ctx, db, `SELECT jsonb_build_object('channel',x.channel,'state',x.state,'count',count(*)::integer) FROM operations_messaging_recipients_v1 x JOIN operations_messaging_runs_v1 r ON r.id=x.run_id JOIN operations_messaging_plans_v1 p ON p.id=r.plan_id WHERE r.endpoint=$1 AND ($2::text IS NULL OR p.state=$2) GROUP BY x.channel,x.state`, s.Endpoint, state)
	if e != nil {
		return nil, e
	}
	return Object{"scope": "matching-plans-all-runs", "plans": groupCounts(plans, []string{"draft", "active", "paused", "stopped"}), "runs": groupCounts(runs, []string{"running", "paused", "blocked", "completed", "cancelled", "expired"}), "delivery": deliveryCounts(recipients)}, nil
}
func (s *Service) List(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parsePage(input, "state")
	if e != nil {
		return nil, e
	}
	if q.state != nil && !contains([]string{"draft", "active", "paused", "stopped"}, str(q.state)) {
		return nil, invalidInput()
	}
	return s.read(ctx, a, func(tx pgx.Tx, actor Actor) (Object, error) {
		rows, e := many(ctx, tx, `SELECT to_jsonb(p)||jsonb_build_object('config',v.config) FROM operations_messaging_plans_v1 p JOIN operations_messaging_versions_v1 v ON v.plan_id=p.id AND v.version=p.version WHERE p.endpoint=$1 AND ($2::bigint IS NULL OR p.sequence<$2) AND ($3::text IS NULL OR p.state=$3) ORDER BY p.sequence DESC LIMIT $4`, s.Endpoint, q.after, q.state, q.limit+1)
		if e != nil {
			return nil, e
		}
		var legacy int
		if e = tx.QueryRow(ctx, `SELECT count(*) FROM operations_notices_v1 n WHERE endpoint=$1 AND NOT EXISTS(SELECT 1 FROM operations_messaging_runs_v1 r WHERE r.id=n.id)`, s.Endpoint).Scan(&legacy); e != nil {
			return nil, e
		}
		summary, e := s.overview(ctx, tx, q.state)
		if e != nil {
			return nil, e
		}
		rows, next := cutPage(rows, q.limit)
		items := []any{}
		for _, row := range rows {
			items = append(items, s.planView(row, actor))
		}
		return Object{"items": items, "nextAfter": next, "capabilities": Object{"canCreate": has(actor, "notices.create")}, "audienceAvailability": audienceAvailability(), "summary": summary, "sender": s.senderStatusWithin(ctx, tx), "legacy": Object{"source": "operations-notices", "count": legacy, "historyPreserved": true}, "metadataOnly": false, "checkedAt": s.now().Unix(), "readExpiresAt": s.now().Unix() + 30}, nil
	})
}
func (s *Service) Announcements(ctx context.Context, input Object) (Object, error) {
	q, e := parsePage(input)
	if e != nil {
		return nil, e
	}
	rows, e := many(ctx, s.Pool, `SELECT to_jsonb(a) FROM operations_messaging_announcements_v1 a WHERE endpoint=$1 AND withdrawn_at IS NULL AND expires_at>$2 AND ($3::bigint IS NULL OR sequence<$3) ORDER BY sequence DESC LIMIT $4`, s.Endpoint, s.now(), q.after, q.limit+1)
	if e != nil {
		return nil, e
	}
	rows, next := cutPage(rows, q.limit)
	items := []any{}
	until := s.now().Unix() + 30
	for _, row := range rows {
		value := obj(clone(row["content"]))
		value["id"] = row["id"]
		value["sequence"] = str(row["sequence"])
		value["publishedAt"] = stamp(row["published_at"])
		value["expiresAt"] = stamp(row["expires_at"])
		value["source"] = "official-announcement"
		items = append(items, value)
		expires, _ := date(row["expires_at"])
		if expires.Unix() < until {
			until = expires.Unix()
		}
	}
	return Object{"items": items, "nextAfter": next, "checkedAt": s.now().Unix(), "readExpiresAt": until}, nil
}
func (s *Service) Announcement(ctx context.Context, id string) (Object, error) {
	if !uuidOK(id) {
		return nil, invalidInput()
	}
	row, e := one(ctx, s.Pool, `SELECT to_jsonb(a) FROM operations_messaging_announcements_v1 a WHERE id=$1 AND endpoint=$2 AND withdrawn_at IS NULL AND expires_at>$3`, id, s.Endpoint, s.now())
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, failure("operations_announcement_not_found", 404)
	}
	if e != nil {
		return nil, e
	}
	value := obj(clone(row["content"]))
	value["id"] = row["id"]
	value["publishedAt"] = stamp(row["published_at"])
	value["expiresAt"] = stamp(row["expires_at"])
	value["source"] = "official-announcement"
	until := s.now().Unix() + 30
	expires, _ := date(row["expires_at"])
	if expires.Unix() < until {
		until = expires.Unix()
	}
	return Object{"announcement": value, "checkedAt": s.now().Unix(), "readExpiresAt": until}, nil
}
