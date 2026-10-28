package messaging

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"time"
)

func (s *SMTPService) Test(ctx context.Context, a Actor, kind string, input Object) (Object, error) {
	allowed := []string{"operationId", "expectedVersion"}
	if kind == "delivery" {
		allowed = append(allowed, "accountId", "senderKey")
	} else if kind != "connection" {
		return nil, failure("invalid_smtp_request", 400)
	}
	if !keys(input, allowed...) || !uuidOK(input["operationId"]) || !intOK(input["expectedVersion"], 1, 2147483646) {
		return nil, failure("invalid_smtp_request", 400)
	}
	if kind == "delivery" {
		if _, ok := OfficialMailIdentities[str(input["senderKey"])]; !ok || !uuidOK(input["accountId"]) {
			return nil, failure("invalid_smtp_request", 400)
		}
	}
	clean := obj(clone(input))
	type testClaim struct {
		prior, row, current Object
		actor               Actor
	}
	claim, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (testClaim, error) {
		actor, e := s.require(ctx, tx, a, "smtp.test."+kind)
		if e != nil {
			return testClaim{}, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912423))", s.Endpoint+":"+str(input["operationId"])); e != nil {
			return testClaim{}, e
		}
		prior, e := one(ctx, tx, "SELECT to_jsonb(t) FROM operations_smtp_tests_v1 t WHERE endpoint=$1 AND id=$2", s.Endpoint, input["operationId"])
		if e == nil {
			if str(prior["operator_id"]) != actor.ID || str(prior["kind"]) != kind || !same(prior["input"], clean) {
				return testClaim{}, failure("operations_command_changed")
			}
			return testClaim{prior: prior}, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return testClaim{}, e
		}
		current, e := s.current(ctx, tx)
		if e != nil {
			return testClaim{}, e
		}
		if num(current["version"]) != num(input["expectedVersion"]) {
			return testClaim{}, failure("smtp_configuration_changed")
		}
		row, e := one(ctx, tx, `WITH inserted AS(INSERT INTO operations_smtp_tests_v1(id,endpoint,operator_id,kind,configuration_version,account_id,sender_key,input,state,started_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'testing',$9) RETURNING *) SELECT to_jsonb(inserted) FROM inserted`, input["operationId"], s.Endpoint, actor.ID, kind, num(current["version"]), input["accountId"], input["senderKey"], encode(clean), s.now())
		return testClaim{row: row, current: current, actor: actor}, e
	})
	if e != nil {
		return nil, e
	}
	if claim.prior != nil {
		return Object{"test": s.testView(claim.prior), "replayed": true}, nil
	}
	fresh := func(c context.Context) error {
		_, e := postgres.InTx(c, s.Pool, func(tx pgx.Tx) (bool, error) {
			if _, e := s.require(c, tx, a, "smtp.test."+kind); e != nil {
				return false, e
			}
			current, e := s.current(c, tx)
			if e != nil {
				return false, e
			}
			if num(current["version"]) != num(input["expectedVersion"]) {
				return false, failure("smtp_configuration_changed")
			}
			return true, nil
		})
		return e
	}
	var result ProviderResult
	if kind == "delivery" {
		result, e = s.Submit(ctx, MailRequest{AccountID: str(input["accountId"]), MessageID: "<smtp-test-" + str(input["operationId"]) + "@agigalaxy.org>", SenderKey: str(input["senderKey"]), Subject: "银河 SMTP 投递测试", Title: "发信服务投递测试", Paragraphs: []string{"这是一封由获准管理操作发起的发信服务测试邮件。"}, Authorize: fresh, Test: true})
		if e != nil {
			return nil, e
		}
	} else {
		x := obj(claim.current["configuration"])
		var credentials *Credentials
		if completeSMTP(x) && s.Credentials != nil {
			credentials, e = s.Credentials.Resolve(CredentialSelection{Ref: str(x["credentialRef"]), Host: str(x["host"]), Port: int(num(x["port"])), TLS: str(x["tls"])})
		}
		if e != nil {
			result = ProviderResult{Submission: failed(smtpSafeAuthorization(e), false)}
		} else if credentials == nil {
			v := failed("smtp_not_configured", false)
			v.Submission = "not-configured"
			result = ProviderResult{Submission: v}
		} else {
			result = s.withPermit(claim.current, func() Submission { return s.Transport.Verify(ctx, transportConfiguration(x), *credentials, fresh) })
		}
	}
	receiptCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	row, e := postgres.InTx(receiptCtx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := one(receiptCtx, tx, `WITH changed AS(UPDATE operations_smtp_tests_v1 SET state=$3,code=$4,finished_at=$5 WHERE endpoint=$1 AND id=$2 RETURNING *) SELECT to_jsonb(changed) FROM changed`, s.Endpoint, input["operationId"], result.Submission.Submission, result.Code, s.now())
		if e != nil {
			return nil, e
		}
		action := "smtp-connection-test"
		if kind == "delivery" {
			action = "smtp-delivery-test"
		}
		if e = s.helper().audit(receiptCtx, tx, claim.actor, action, input["operationId"], input["accountId"], Object{"testId": input["operationId"], "expectedVersion": input["expectedVersion"]}, Object{"state": row["state"], "code": row["code"], "version": input["expectedVersion"]}); e != nil {
			return nil, e
		}
		return row, nil
	})
	if e != nil {
		return nil, e
	}
	return Object{"test": s.testView(row), "replayed": false}, nil
}
func (s *SMTPService) Tests(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := smtpPage(input)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.require(ctx, tx, a, "smtp.read"); e != nil {
			return nil, e
		}
		rows, e := many(ctx, tx, `SELECT to_jsonb(t) FROM operations_smtp_tests_v1 t WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3`, s.Endpoint, q.after, q.limit+1)
		if e != nil {
			return nil, e
		}
		rows, next := cutPage(rows, q.limit)
		items := []any{}
		for _, row := range rows {
			items = append(items, s.testView(row))
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now().Unix()}, nil
	})
}
func (s *SMTPService) History(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := smtpPage(input)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.require(ctx, tx, a, "smtp.read"); e != nil {
			return nil, e
		}
		rows, e := many(ctx, tx, `SELECT to_jsonb(t) FROM operations_smtp_events_v1 t WHERE endpoint=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3`, s.Endpoint, q.after, q.limit+1)
		if e != nil {
			return nil, e
		}
		rows, next := cutPage(rows, q.limit)
		items := []any{}
		for _, row := range rows {
			items = append(items, Object{"id": row["id"], "sequence": str(row["sequence"]), "operatorId": row["operator_id"], "version": row["version"], "changedFields": row["changed_fields"], "createdAt": stamp(row["created_at"])})
		}
		return Object{"items": items, "nextAfter": next, "checkedAt": s.now().Unix()}, nil
	})
}
func (s *SMTPService) Queue(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := smtpPage(input)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.require(ctx, tx, a, "smtp.read"); e != nil {
			return nil, e
		}
		rows, e := many(ctx, tx, `SELECT to_jsonb(r)||jsonb_build_object('uid',a.uid,'plan_id',u.plan_id) FROM operations_messaging_recipients_v1 r JOIN operations_messaging_runs_v1 u ON u.id=r.run_id LEFT JOIN community_accounts a ON a.id=r.account_id WHERE u.endpoint=$1 AND r.channel='email' AND ($2::bigint IS NULL OR r.sequence<$2) ORDER BY r.sequence DESC LIMIT $3`, s.Endpoint, q.after, q.limit+1)
		if e != nil {
			return nil, e
		}
		counts, e := many(ctx, tx, `SELECT jsonb_build_object('state',r.state,'count',count(*)::integer) FROM operations_messaging_recipients_v1 r JOIN operations_messaging_runs_v1 u ON u.id=r.run_id WHERE u.endpoint=$1 AND r.channel='email' GROUP BY r.state`, s.Endpoint)
		if e != nil {
			return nil, e
		}
		rows, next := cutPage(rows, q.limit)
		items := []any{}
		for _, row := range rows {
			items = append(items, Object{"id": row["id"], "sequence": str(row["sequence"]), "accountId": row["account_id"], "uid": row["uid"], "runId": row["run_id"], "planId": row["plan_id"], "state": row["state"], "attemptCount": row["attempt_count"], "code": row["error_code"], "submittedAt": stamp(row["submitted_at"]), "completedAt": stamp(row["completed_at"]), "updatedAt": stamp(row["updated_at"])})
		}
		totals := Object{}
		for _, row := range counts {
			totals[str(row["state"])] = row["count"]
		}
		return Object{"items": items, "nextAfter": next, "counts": totals, "scope": "configured-business-database", "checkedAt": s.now().Unix()}, nil
	})
}
func (s *SMTPService) Bounces(ctx context.Context, a Actor) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if _, e := s.require(ctx, tx, a, "smtp.read"); e != nil {
			return nil, e
		}
		return Object{"state": "not-connected", "items": []any{}, "count": nil, "source": nil, "checkedAt": s.now().Unix()}, nil
	})
}
