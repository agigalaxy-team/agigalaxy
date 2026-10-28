package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"math"
	"unicode/utf8"
)

func productInvalid() error { return failure("invalid_operations_product_request", 400) }
func noticeContent(input any) (Object, error) {
	content := obj(clone(input))
	if content == nil || !keys(content, "purpose", "title", "body", "href", "audience", "expiresAt") || !required(content, "purpose", "title", "body", "audience", "expiresAt") || !contains([]string{"maintenance", "service-update", "community-update"}, str(content["purpose"])) {
		return nil, productInvalid()
	}
	for key, max := range map[string]int{"title": 160, "body": 8000} {
		value, ok := content[key].(string)
		if !ok || value == "" || utf8.RuneCountInString(value) > max {
			return nil, productInvalid()
		}
		for _, r := range value {
			if r < 32 && r != '\n' && r != '\t' && r != '\r' {
				return nil, productInvalid()
			}
		}
	}
	if _, e := date(content["expiresAt"]); e != nil {
		return nil, productInvalid()
	}
	audience := obj(content["audience"])
	kind := str(audience["kind"])
	if kind != "all-accounts" && kind != "accounts" {
		return nil, productInvalid()
	}
	if kind == "all-accounts" && !keys(audience, "kind") {
		return nil, productInvalid()
	}
	if kind == "accounts" {
		ids := arr(audience["accountIds"])
		if !keys(audience, "kind", "accountIds") || len(ids) < 1 || len(ids) > 500 {
			return nil, productInvalid()
		}
		seen := map[string]bool{}
		for _, id := range ids {
			if !uuidOK(id) || seen[str(id)] {
				return nil, productInvalid()
			}
			seen[str(id)] = true
		}
	}
	// Reuse the exact href validator, while retaining this legacy surface's
	// deliberate non-trimming title/body semantics.
	candidate := Object{"channels": []any{"inapp"}, "content": Object{"purpose": content["purpose"], "title": "valid", "body": "valid", "href": content["href"], "expiresAt": content["expiresAt"]}, "audience": audience, "schedule": Object{"kind": "immediate"}}
	normalized, e := normalizeConfig(candidate)
	if e != nil {
		return nil, productInvalid()
	}
	content["href"] = obj(normalized["content"])["href"]
	return content, nil
}
func (s *Service) noticeRow(ctx context.Context, db Reader, id string, lock bool) (Object, error) {
	if !uuidOK(id) {
		return nil, productInvalid()
	}
	suffix := ""
	if lock {
		suffix = " FOR UPDATE"
	}
	row, e := one(ctx, db, "SELECT to_jsonb(n) FROM operations_notices_v1 n WHERE id=$1 AND endpoint=$2"+suffix, id, s.Endpoint)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, failure("operations_notice_not_found", 404)
	}
	return row, e
}
func (s *Service) noticeView(ctx context.Context, db Reader, row Object) (Object, error) {
	counts, e := one(ctx, db, `SELECT jsonb_build_object('targets',count(*)::integer,'delivered',count(*) FILTER(WHERE delivered_at IS NOT NULL)::integer,'read',count(*) FILTER(WHERE read_at IS NOT NULL)::integer) FROM account_operations_notices_v1 WHERE notice_id=$1`, row["id"])
	if e != nil {
		return nil, e
	}
	state := str(row["state"])
	expires, _ := date(row["expires_at"])
	if !contains([]string{"draft", "withdrawn"}, state) && !expires.After(s.now()) {
		state = "expired"
	}
	return Object{"id": row["id"], "sequence": str(row["sequence"]), "version": row["version"], "state": state, "content": row["content"], "createdBy": row["created_by"], "updatedBy": row["updated_by"], "publishedBy": row["published_by"], "publishedAt": stamp(row["published_at"]), "expiresAt": stamp(row["expires_at"]), "createdAt": stamp(row["created_at"]), "updatedAt": stamp(row["updated_at"]), "jobId": row["job_id"], "delivery": Object{"audienceCount": row["audience_count"], "deliveredCount": counts["delivered"], "readCount": counts["read"], "skippedCount": int64(math.Max(0, float64(num(row["audience_count"])-num(counts["targets"])))), "pendingCount": num(counts["targets"]) - num(counts["delivered"]), "errorCode": row["delivery_error_code"], "lastAttemptAt": stamp(row["last_attempt_at"])}}, nil
}
func (s *Service) NoticeList(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := parsePage(input)
	if e != nil {
		return nil, productInvalid()
	}
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		rows, e := many(ctx, tx, `SELECT to_jsonb(n) FROM operations_notices_v1 n WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3`, s.Endpoint, q.after, q.limit+1)
		if e != nil {
			return nil, e
		}
		rows, next := cutPage(rows, q.limit)
		items := []any{}
		for _, row := range rows {
			value, e := s.noticeView(ctx, tx, row)
			if e != nil {
				return nil, e
			}
			items = append(items, value)
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now().Unix()}, nil
	})
}
func (s *Service) NoticeGet(ctx context.Context, a Actor, id string) (Object, error) {
	return s.read(ctx, a, func(tx pgx.Tx, _ Actor) (Object, error) {
		row, e := s.noticeRow(ctx, tx, id, false)
		if e != nil {
			return nil, e
		}
		view, e := s.noticeView(ctx, tx, row)
		return Object{"notice": view}, e
	})
}
func (s *Service) noticeCommand(ctx context.Context, a Actor, kind string, input Object, execute func(pgx.Tx, Actor) (Object, Object, Object, error)) (Object, error) {
	permission := map[string]string{"notice-create": "notices.create", "notice-save": "notices.update", "notice-publish": "notices.publish", "notice-withdraw": "notices.withdraw"}[kind]
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		actor, e := s.require(ctx, tx, a, permission)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", s.Endpoint+":operations-product:"+str(input["operationId"])); e != nil {
			return nil, e
		}
		prior, e := one(ctx, tx, "SELECT to_jsonb(c) FROM operations_product_commands_v1 c WHERE endpoint=$1 AND operation_id=$2", s.Endpoint, input["operationId"])
		if e == nil {
			if str(prior["operator_id"]) != actor.ID || str(prior["action"]) != kind || !same(prior["input"], input) {
				return nil, failure("operations_command_changed")
			}
			value := obj(clone(prior["result"]))
			value["replayed"] = true
			return value, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		value, selection, outcome, e := execute(tx, actor)
		if e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, actor, kind, input["operationId"], nil, selection, outcome); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO operations_product_commands_v1(endpoint,operation_id,operator_id,action,input,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)", s.Endpoint, input["operationId"], actor.ID, kind, encode(input), encode(value), s.now()); e != nil {
			return nil, e
		}
		value["replayed"] = false
		return value, nil
	})
}
func (s *Service) NoticeCreate(ctx context.Context, a Actor, input Object) (Object, error) {
	if !keys(input, "operationId", "content") || !uuidOK(input["operationId"]) {
		return nil, productInvalid()
	}
	content, e := noticeContent(input["content"])
	if e != nil {
		return nil, e
	}
	clean := Object{"operationId": input["operationId"], "content": content}
	return s.noticeCommand(ctx, a, "notice-create", clean, func(tx pgx.Tx, actor Actor) (Object, Object, Object, error) {
		expires, _ := date(content["expiresAt"])
		if !expires.After(s.now()) {
			return nil, nil, nil, failure("operations_notice_expiry_invalid", 400)
		}
		row, e := one(ctx, tx, `WITH inserted AS(INSERT INTO operations_notices_v1(id,endpoint,version,content,state,created_by,updated_by,expires_at,created_at,updated_at) VALUES($1,$2,1,$3,'draft',$4,$4,$5,$6,$6) RETURNING *) SELECT to_jsonb(inserted) FROM inserted`, input["operationId"], s.Endpoint, encode(content), actor.ID, content["expiresAt"], s.now())
		if e != nil {
			return nil, nil, nil, e
		}
		view, e := s.noticeView(ctx, tx, row)
		return Object{"notice": view}, Object{"noticeId": row["id"]}, Object{"state": "draft", "version": 1}, e
	})
}
func (s *Service) NoticeSave(ctx context.Context, a Actor, id string, input Object) (Object, error) {
	if !uuidOK(id) || !keys(input, "operationId", "expectedVersion", "content") || !uuidOK(input["operationId"]) || !intOK(input["expectedVersion"], 1, 2147483646) {
		return nil, productInvalid()
	}
	content, e := noticeContent(input["content"])
	if e != nil {
		return nil, e
	}
	clean := Object{"operationId": input["operationId"], "expectedVersion": input["expectedVersion"], "content": content, "noticeId": id}
	return s.noticeCommand(ctx, a, "notice-save", clean, func(tx pgx.Tx, actor Actor) (Object, Object, Object, error) {
		expires, _ := date(content["expiresAt"])
		if !expires.After(s.now()) {
			return nil, nil, nil, failure("operations_notice_expiry_invalid", 400)
		}
		current, e := s.noticeRow(ctx, tx, id, true)
		if e != nil {
			return nil, nil, nil, e
		}
		if num(current["version"]) != num(input["expectedVersion"]) {
			return nil, nil, nil, failure("operations_notice_version_changed")
		}
		if str(current["state"]) != "draft" {
			return nil, nil, nil, failure("operations_notice_not_draft")
		}
		row, e := one(ctx, tx, `WITH changed AS(UPDATE operations_notices_v1 SET content=$2,expires_at=$3,version=version+1,updated_by=$4,updated_at=$5 WHERE id=$1 RETURNING *) SELECT to_jsonb(changed) FROM changed`, id, encode(content), content["expiresAt"], actor.ID, s.now())
		if e != nil {
			return nil, nil, nil, e
		}
		view, e := s.noticeView(ctx, tx, row)
		return Object{"notice": view}, Object{"noticeId": id, "expectedVersion": input["expectedVersion"]}, Object{"version": row["version"], "state": row["state"]}, e
	})
}
func (s *Service) NoticeAction(ctx context.Context, a Actor, id, kind string, input Object) (Object, error) {
	if !contains([]string{"publish", "withdraw"}, kind) || !uuidOK(id) || !keys(input, "operationId", "expectedVersion") || !uuidOK(input["operationId"]) || !intOK(input["expectedVersion"], 1, 9007199254740991) {
		return nil, productInvalid()
	}
	clean := obj(clone(input))
	clean["noticeId"] = id
	return s.noticeCommand(ctx, a, "notice-"+kind, clean, func(tx pgx.Tx, actor Actor) (Object, Object, Object, error) {
		row, e := s.noticeRow(ctx, tx, id, true)
		if e != nil {
			return nil, nil, nil, e
		}
		if num(row["version"]) != num(input["expectedVersion"]) {
			return nil, nil, nil, failure("operations_notice_version_changed")
		}
		selection := Object{"noticeId": id, "expectedVersion": input["expectedVersion"]}
		var outcome Object
		if kind == "withdraw" {
			if str(row["state"]) == "withdrawn" {
				return nil, nil, nil, failure("operations_notice_already_withdrawn")
			}
			if _, e = tx.Exec(ctx, "UPDATE operations_notices_v1 SET state='withdrawn',version=version+1,updated_by=$2,updated_at=$3 WHERE id=$1", id, actor.ID, s.now()); e != nil {
				return nil, nil, nil, e
			}
			outcome = Object{"version": num(row["version"]) + 1, "state": "withdrawn"}
		} else {
			if str(row["state"]) != "draft" {
				return nil, nil, nil, failure("operations_notice_not_draft")
			}
			content := obj(row["content"])
			expires, _ := date(content["expiresAt"])
			if !expires.After(s.now()) {
				return nil, nil, nil, failure("operations_notice_expiry_invalid", 400)
			}
			audience := obj(content["audience"])
			var selected any
			if str(audience["kind"]) == "accounts" {
				selected = list(audience["accountIds"])
			}
			var count int
			if e = tx.QueryRow(ctx, `WITH recipients AS(INSERT INTO account_operations_notices_v1(notice_id,account_id) SELECT $1,id FROM community_accounts WHERE endpoint=$2 AND ($3::uuid[] IS NULL OR id=ANY($3)) RETURNING account_id) SELECT count(*)::integer FROM recipients`, id, s.Endpoint, selected).Scan(&count); e != nil {
				return nil, nil, nil, e
			}
			if selected != nil && count != len(list(audience["accountIds"])) {
				return nil, nil, nil, failure("operations_notice_audience_unavailable")
			}
			jobID, e := s.enqueue(ctx, tx, jobs.AccountNotice, id, "notice:"+id+":start", 0, s.now())
			if e != nil {
				return nil, nil, nil, e
			}
			if jobID == "" {
				return nil, nil, nil, failure("operations_notice_queue_unavailable", 503)
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_notices_v1 SET state='queued',version=version+1,published_by=$2,published_at=$3,updated_at=$3,updated_by=$2,audience_count=$4,job_id=$5 WHERE id=$1`, id, actor.ID, s.now(), count, jobID); e != nil {
				return nil, nil, nil, e
			}
			selection["audience"] = audience["kind"]
			outcome = Object{"version": num(row["version"]) + 1, "state": "queued", "audienceCount": count}
		}
		row, e = s.noticeRow(ctx, tx, id, false)
		if e != nil {
			return nil, nil, nil, e
		}
		view, e := s.noticeView(ctx, tx, row)
		return Object{"notice": view}, selection, outcome, e
	})
}
func (s *Service) NoticeAccountQuery(ctx context.Context, accountID string, authorization accounts.Authorization, input Object) (Object, error) {
	q, e := parsePage(input, "unreadOnly")
	if e != nil {
		return nil, productInvalid()
	}
	unread := false
	if v, exists := input["unreadOnly"]; exists {
		var ok bool
		unread, ok = v.(bool)
		if !ok {
			return nil, productInvalid()
		}
	}
	if !uuidOK(accountID) || authorization == nil {
		return nil, failure("access_denied", 403)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := authorization.Account(ctx, tx, s.Endpoint, accountID); e != nil {
			return nil, e
		}
		rows, e := many(ctx, tx, `SELECT to_jsonb(n)||jsonb_build_object('recipient_sequence',r.sequence,'delivered_at',r.delivered_at,'read_at',r.read_at) FROM account_operations_notices_v1 r JOIN operations_notices_v1 n ON n.id=r.notice_id WHERE r.account_id=$1 AND n.endpoint=$2 AND r.delivered_at IS NOT NULL AND n.state IN ('queued','delivering','delivered') AND n.expires_at>$3 AND ($4::bigint IS NULL OR r.sequence<$4) AND (NOT $5::boolean OR r.read_at IS NULL) ORDER BY r.sequence DESC LIMIT $6`, accountID, s.Endpoint, s.now(), q.after, unread, q.limit+1)
		if e != nil {
			return nil, e
		}
		var next any
		if len(rows) > q.limit {
			next = str(rows[q.limit-1]["recipient_sequence"])
			rows = rows[:q.limit]
		}
		items := []any{}
		for _, row := range rows {
			content := obj(row["content"])
			items = append(items, Object{"noticeId": row["id"], "kind": "service-notice", "purpose": content["purpose"], "title": content["title"], "body": content["body"], "href": content["href"], "at": stamp(row["delivered_at"]), "expiresAt": stamp(row["expires_at"]), "read": row["read_at"] != nil, "source": Object{"kind": "business-operator", "serviceEndpoint": s.Endpoint}})
		}
		if e = authorization.Account(ctx, tx, s.Endpoint, accountID); e != nil {
			return nil, e
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now().Unix()}, nil
	})
}
func (s *Service) NoticeAccountMarkRead(ctx context.Context, accountID string, authorization accounts.Authorization, input Object) (Object, error) {
	if !keys(input, "noticeId") || !uuidOK(input["noticeId"]) {
		return nil, productInvalid()
	}
	if !uuidOK(accountID) || authorization == nil {
		return nil, failure("access_denied", 403)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := authorization.Account(ctx, tx, s.Endpoint, accountID); e != nil {
			return nil, e
		}
		tag, e := tx.Exec(ctx, `UPDATE account_operations_notices_v1 r SET read_at=COALESCE(r.read_at,$3) FROM operations_notices_v1 n WHERE r.notice_id=$1 AND r.account_id=$2 AND n.id=r.notice_id AND n.endpoint=$4 AND r.delivered_at IS NOT NULL AND n.state IN ('queued','delivering','delivered') AND n.expires_at>$3`, input["noticeId"], accountID, s.now(), s.Endpoint)
		if e != nil {
			return nil, e
		}
		if tag.RowsAffected() == 0 {
			return nil, failure("operations_notice_not_found", 404)
		}
		if e = authorization.Account(ctx, tx, s.Endpoint, accountID); e != nil {
			return nil, e
		}
		return Object{"noticeId": input["noticeId"], "read": true, "checkedAt": s.now().Unix()}, nil
	})
}
