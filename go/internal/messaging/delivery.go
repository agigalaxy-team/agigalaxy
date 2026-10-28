package messaging

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"math"
	"regexp"
	"strings"
	"time"
)

const maxSubmitAttempts = 4
const submissionLease = 300 * time.Second
const deliveryPageSize = 25

func (s *Service) senderStatus(ctx context.Context) Object {
	if s.Mail != nil {
		if status, e := s.Mail.Status(ctx); e == nil {
			return Object{"state": status["state"], "enabled": status["enabled"], "configVersion": status["configVersion"], "receipts": "not-connected"}
		}
	}
	return Object{"state": "not-configured", "enabled": false, "configVersion": nil, "receipts": "not-connected"}
}
func (s *Service) recoverSubmissions(ctx context.Context, tx pgx.Tx, runID string) (int, error) {
	rows, e := many(ctx, tx, `WITH changed AS(UPDATE operations_messaging_recipients_v1 SET state='unknown',retryable=false,retry_at=NULL,error_code='operations_messaging_submission_unconfirmed',completed_at=$2,updated_at=$2 WHERE run_id=$1 AND state='submitting' AND lease_until<=$2 RETURNING attempt_id) SELECT to_jsonb(changed) FROM changed`, runID, s.now())
	if e != nil {
		return 0, e
	}
	for _, row := range rows {
		if row["attempt_id"] != nil {
			if _, e = tx.Exec(ctx, `UPDATE operations_messaging_attempts_v1 SET state='unknown',error_code='operations_messaging_submission_unconfirmed',finished_at=$2 WHERE id=$1 AND state='submitting'`, row["attempt_id"], s.now()); e != nil {
				return 0, e
			}
		}
	}
	return len(rows), nil
}
func (s *Service) recipientEligibility(ctx context.Context, tx pgx.Tx, run, recipient Object) (string, string, error) {
	row, e := one(ctx, tx, `SELECT jsonb_build_object('id',a.id,'issuer',a.issuer,'externalSubject',a.external_subject,'subjectType',p.subject_type) FROM community_accounts a LEFT JOIN official_account_profiles_v1 p ON p.account_id=a.id WHERE a.id=$1 AND a.endpoint=$2`, recipient["account_id"], s.Endpoint)
	if errors.Is(e, pgx.ErrNoRows) {
		return "skipped", "operations_messaging_recipient_unavailable", nil
	}
	if e != nil {
		return "", "", e
	}
	audience := obj(obj(run["config"])["audience"])
	if str(audience["kind"]) == "accounts" && !contains(list(audience["accountIds"]), str(row["id"])) || str(audience["kind"]) == "attributes" && !contains(list(audience["subjectTypes"]), str(row["subjectType"])) {
		return "skipped", "operations_messaging_recipient_ineligible", nil
	}
	if s.Directory == nil {
		return "blocked", "operations_messaging_directory_unavailable", nil
	}
	identity, e := s.Directory(ctx, str(row["issuer"]), str(row["externalSubject"]))
	if e != nil || identity.State != "available" || identity.Issuer != str(row["issuer"]) || identity.ExternalSubject != str(row["externalSubject"]) {
		code := "operations_messaging_directory_unavailable"
		if identity.State == "not-found" {
			code = "operations_messaging_recipient_unavailable"
		}
		return "blocked", code, nil
	}
	if !identity.Enabled {
		return "skipped", "operations_messaging_recipient_disabled", nil
	}
	return "eligible", "", nil
}

type deliveryClaim struct {
	processed                                                   bool
	runID, recipientID, accountID, attemptID, messageID, planID string
	planVersion                                                 int64
	config                                                      Object
	actor                                                       ApprovedActor
}

func messageID(endpoint, runID, accountID string) string {
	sum := sha256.Sum256([]byte(encode([]string{endpoint, runID, accountID, "email"})))
	return "<" + hex.EncodeToString(sum[:]) + "@messages.agigalaxy.org>"
}
func (s *Service) claim(ctx context.Context, runID string) (*deliveryClaim, error) {
	provider := s.senderStatus(ctx)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (*deliveryClaim, error) {
		run, e := s.runWithin(ctx, tx, runID, false)
		if e != nil {
			return nil, e
		}
		_, actor, e := s.runtimeWithin(ctx, tx, run)
		if e != nil {
			return nil, e
		}
		run, e = s.runWithin(ctx, tx, runID, true)
		if e != nil {
			return nil, e
		}
		if _, e = s.recoverSubmissions(ctx, tx, runID); e != nil {
			return nil, e
		}
		recipient, e := one(ctx, tx, `SELECT to_jsonb(r) FROM operations_messaging_recipients_v1 r WHERE run_id=$1 AND (state='pending' AND (retry_at IS NULL OR retry_at<=$2) OR state='failed' AND retryable=true AND retry_at<=$2 AND attempt_count<$3) ORDER BY sequence LIMIT 1 FOR UPDATE`, runID, s.now(), maxSubmitAttempts)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil, nil
		}
		if e != nil {
			return nil, e
		}
		eligibility, code, e := s.recipientEligibility(ctx, tx, run, recipient)
		if e != nil {
			return nil, e
		}
		if _, _, e = s.runtimeWithin(ctx, tx, run); e != nil {
			return nil, e
		}
		processed := func() (*deliveryClaim, error) {
			_, e := tx.Exec(ctx, "UPDATE operations_messaging_runs_v1 SET revision=revision+1,updated_at=$2 WHERE id=$1", runID, s.now())
			return &deliveryClaim{processed: true}, e
		}
		if eligibility != "eligible" {
			if _, e = tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state=$2,error_code=$3,retryable=false,completed_at=$4,updated_at=$4 WHERE id=$1`, recipient["id"], eligibility, code, s.now()); e != nil {
				return nil, e
			}
			return processed()
		}
		if str(recipient["channel"]) == "inapp" {
			notice, e := one(ctx, tx, "SELECT to_jsonb(n) FROM operations_notices_v1 n WHERE id=$1 AND endpoint=$2 FOR UPDATE", runID, s.Endpoint)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return nil, e
			}
			expires, _ := date(notice["expires_at"])
			if notice == nil || !contains([]string{"queued", "delivering", "delivered"}, str(notice["state"])) || !expires.After(s.now()) {
				if _, e = tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state='skipped',retryable=false,error_code='operations_messaging_inapp_source_unavailable',completed_at=$2,updated_at=$2 WHERE id=$1`, recipient["id"], s.now()); e != nil {
					return nil, e
				}
				return processed()
			}
			if _, e = tx.Exec(ctx, "UPDATE account_operations_notices_v1 SET delivered_at=COALESCE(delivered_at,$3) WHERE notice_id=$1 AND account_id=$2", runID, recipient["account_id"], s.now()); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state='delivered',retryable=false,completed_at=$2,updated_at=$2 WHERE id=$1`, recipient["id"], s.now()); e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_notices_v1 SET state='delivering',last_attempt_at=$2,updated_at=$2 WHERE id=$1 AND state IN ('queued','delivering')`, runID, s.now()); e != nil {
				return nil, e
			}
			if e = s.auditApproved(ctx, tx, actor, Object{"kind": "inapp-delivery", "planId": run["plan_id"], "runId": runID, "recipientId": recipient["id"], "planVersion": run["plan_version"], "channel": "inapp"}, Object{"state": "delivered"}, recipient["account_id"]); e != nil {
				return nil, e
			}
			return processed()
		}
		if str(provider["state"]) != "configured" || !boolValue(provider["enabled"]) || s.Mail == nil {
			if _, e = tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state='blocked',error_code='smtp_not_configured',retryable=false,updated_at=$2 WHERE id=$1`, recipient["id"], s.now()); e != nil {
				return nil, e
			}
			return processed()
		}
		attempt := uuid.NewString()
		var number int
		if e = tx.QueryRow(ctx, "SELECT COALESCE(max(attempt_number),0)+1 FROM operations_messaging_attempts_v1 WHERE recipient_id=$1", recipient["id"]).Scan(&number); e != nil {
			return nil, e
		}
		id := str(recipient["message_id"])
		if id == "" {
			id = messageID(s.Endpoint, runID, str(recipient["account_id"]))
		}
		if _, e = tx.Exec(ctx, `INSERT INTO operations_messaging_attempts_v1(id,recipient_id,attempt_number,state,started_at) VALUES($1,$2,$3,'submitting',$4)`, attempt, recipient["id"], number, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state='submitting',attempt_id=$2,attempt_count=$3,message_id=$4,lease_until=$5,retry_at=NULL,retryable=false,error_code=NULL,completed_at=NULL,updated_at=$6 WHERE id=$1`, recipient["id"], attempt, num(recipient["attempt_count"])+1, id, s.now().Add(submissionLease), s.now()); e != nil {
			return nil, e
		}
		if _, e = processed(); e != nil {
			return nil, e
		}
		return &deliveryClaim{runID: runID, recipientID: str(recipient["id"]), accountID: str(recipient["account_id"]), attemptID: attempt, messageID: id, config: obj(run["config"]), actor: actor, planID: str(run["plan_id"]), planVersion: num(run["plan_version"])}, nil
	})
}
func (s *Service) assertSubmission(ctx context.Context, claim *deliveryClaim) error {
	_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
		run, e := s.runWithin(ctx, tx, claim.runID, false)
		if e != nil {
			return false, e
		}
		if _, _, e = s.runtimeWithin(ctx, tx, run); e != nil {
			return false, e
		}
		run, e = s.runWithin(ctx, tx, claim.runID, true)
		if e != nil {
			return false, e
		}
		recipient, e := one(ctx, tx, "SELECT to_jsonb(r) FROM operations_messaging_recipients_v1 r WHERE id=$1 AND run_id=$2 FOR UPDATE", claim.recipientID, claim.runID)
		if errors.Is(e, pgx.ErrNoRows) {
			return false, failure("operations_messaging_attempt_changed")
		}
		if e != nil {
			return false, e
		}
		lease, _ := date(recipient["lease_until"])
		if str(recipient["state"]) != "submitting" || str(recipient["attempt_id"]) != claim.attemptID || !lease.After(s.now()) {
			return false, failure("operations_messaging_attempt_changed")
		}
		state, code, e := s.recipientEligibility(ctx, tx, run, recipient)
		if e != nil {
			return false, e
		}
		if state != "eligible" {
			status := 403
			if state == "blocked" {
				status = 503
			}
			return false, failure(code, status)
		}
		_, _, e = s.runtimeWithin(ctx, tx, run)
		return e == nil, e
	})
	return e
}

var safeProviderCodes = map[string]bool{"smtp_not_configured": true, "smtp_credential_unavailable": true, "smtp_credential_binding_mismatch": true, "smtp_configuration_changed": true, "smtp_authorization_unavailable": true, "smtp_authorization_changed": true, "smtp_recipient_ineligible": true, "smtp_message_invalid": true, "smtp_sender_invalid": true, "smtp_temporary_rejection": true, "smtp_permanent_rejection": true, "smtp_submission_unknown": true, "smtp_authentication_failed": true, "smtp_tls_failed": true, "smtp_connection_failed": true, "smtp_timeout": true, "smtp_dns_failed": true, "smtp_protocol_failed": true, "smtp_transport_failed": true, "smtp_recipient_rejected": true, "smtp_concurrency_limited": true, "smtp_rate_limited": true, "operations_permission_denied": true, "business_admin_denied": true, "identity_directory_unavailable": true, "operations_messaging_not_active": true, "operations_messaging_recipient_ineligible": true, "operations_messaging_execution_interrupted": true}

func (s *Service) settle(ctx context.Context, claim *deliveryClaim, result ProviderResult) (Object, error) {
	state, code := result.Submission.Submission, result.Code
	if !contains([]string{"submitted", "not-configured", "ineligible", "failed", "unknown"}, state) {
		state = "unknown"
		v := "operations_messaging_submission_unconfirmed"
		code = &v
	}
	if code != nil && !safeProviderCodes[*code] {
		if state == "submitted" {
			code = nil
		} else {
			v := "operations_messaging_provider_" + strings.ReplaceAll(state, "-", "_")
			code = &v
		}
	}
	var localRetry time.Time
	localDeferred := false
	if state == "failed" && result.Retryable && result.NotSubmitted && code != nil && contains([]string{"smtp_rate_limited", "smtp_concurrency_limited"}, *code) && result.RetryAt != nil {
		at, e := time.Parse(time.RFC3339Nano, *result.RetryAt)
		if e == nil && !at.After(s.now().Add(24*time.Hour)) {
			localDeferred = true
			localRetry = at
			if localRetry.Before(s.now().Add(time.Second)) {
				localRetry = s.now().Add(time.Second)
			}
		}
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		run, e := s.runWithin(ctx, tx, claim.runID, true)
		if e != nil {
			return nil, e
		}
		row, e := one(ctx, tx, "SELECT to_jsonb(r) FROM operations_messaging_recipients_v1 r WHERE id=$1 AND run_id=$2 FOR UPDATE", claim.recipientID, claim.runID)
		if errors.Is(e, pgx.ErrNoRows) || e == nil && (str(row["attempt_id"]) != claim.attemptID || !contains([]string{"submitting", "unknown"}, str(row["state"]))) {
			return Object{"state": "not-recorded"}, nil
		}
		if e != nil {
			return nil, e
		}
		target := state
		switch {
		case localDeferred:
			target = "pending"
		case state == "ineligible":
			target = "skipped"
		case state == "not-configured":
			target = "blocked"
		}
		retryable := localDeferred || state == "failed" && result.Retryable && num(row["attempt_count"]) < maxSubmitAttempts
		var retryAt any
		if localDeferred {
			retryAt = localRetry
		} else if retryable {
			seconds := math.Min(900, 30*math.Pow(2, float64(num(row["attempt_count"])-1)))
			retryAt = s.now().Add(time.Duration(seconds) * time.Second)
		}
		if _, e = tx.Exec(ctx, "UPDATE operations_messaging_attempts_v1 SET state=$2,error_code=$3,finished_at=$4 WHERE id=$1", claim.attemptID, state, code, s.now()); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state=$2,error_code=$3,retryable=$4,retry_at=$5,lease_until=NULL,attempt_count=CASE WHEN $7 THEN GREATEST(0,attempt_count-1) ELSE attempt_count END,submitted_at=CASE WHEN $2='submitted' THEN $6 ELSE submitted_at END,completed_at=CASE WHEN $4 THEN NULL ELSE $6 END,updated_at=$6 WHERE id=$1`, row["id"], target, code, retryable, retryAt, s.now(), localDeferred); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE operations_messaging_runs_v1 SET revision=revision+1,updated_at=$2 WHERE id=$1", claim.runID, s.now()); e != nil {
			return nil, e
		}
		if e = s.auditApproved(ctx, tx, claim.actor, Object{"kind": "email-submission", "planId": claim.planID, "runId": run["id"], "recipientId": row["id"], "planVersion": claim.planVersion, "channel": "email"}, Object{"submission": state, "retryable": retryable, "errorCode": code}, row["account_id"]); e != nil {
			return nil, e
		}
		return Object{"state": target}, nil
	})
}

func (s *Service) finalize(ctx context.Context, runID string) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		run, e := s.runWithin(ctx, tx, runID, true)
		if e != nil {
			return nil, e
		}
		plan, e := s.planWithin(ctx, tx, str(run["plan_id"]), true)
		if e != nil {
			return nil, e
		}
		if _, e = s.recoverSubmissions(ctx, tx, runID); e != nil {
			return nil, e
		}
		stats, e := one(ctx, tx, `SELECT jsonb_build_object('pending',count(*) FILTER(WHERE state='pending' OR state='failed' AND retryable OR state='submitting')::integer,'blocked',count(*) FILTER(WHERE state='blocked')::integer,'issues',count(*) FILTER(WHERE state IN ('failed','unknown'))::integer,'nextAt',min(CASE WHEN state='submitting' THEN lease_until WHEN state='failed' AND retryable THEN retry_at WHEN state='pending' THEN COALESCE(retry_at,$2::timestamptz) END)) FROM operations_messaging_recipients_v1 WHERE run_id=$1`, runID, s.now())
		if e != nil {
			return nil, e
		}
		expires, _ := date(obj(obj(run["config"])["content"])["expiresAt"])
		expired := !expires.After(s.now())
		state := "completed"
		switch {
		case num(plan["version"]) != num(run["plan_version"]) || str(plan["state"]) == "stopped":
			state = "cancelled"
		case expired:
			state = "expired"
		case str(plan["state"]) == "paused":
			state = "paused"
		case num(stats["pending"]) > 0:
			state = "running"
		case num(stats["blocked"]) > 0:
			state = "blocked"
		}
		var code any
		if expired {
			code = "operations_messaging_expired"
		} else if num(stats["issues"]) > 0 {
			code = "operations_messaging_results_incomplete"
		} else if num(stats["blocked"]) > 0 {
			code = "operations_messaging_recipients_blocked"
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_messaging_runs_v1 SET state=$2,error_code=$3,revision=revision+1,updated_at=$4,completed_at=CASE WHEN $2 IN ('completed','cancelled','expired') THEN COALESCE(completed_at,$4) ELSE NULL END WHERE id=$1`, runID, state, code, s.now()); e != nil {
			return nil, e
		}
		if expired {
			if _, e = tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state='skipped',retryable=false,retry_at=NULL,error_code='operations_messaging_expired',completed_at=$2,updated_at=$2 WHERE run_id=$1 AND (state IN ('pending','blocked') OR state='failed' AND retryable)`, runID, s.now()); e != nil {
				return nil, e
			}
		}
		if state == "running" && stats["nextAt"] != nil {
			at, e := date(stats["nextAt"])
			if e != nil {
				return nil, e
			}
			if expires.Before(at) {
				at = expires
			}
			if _, e = s.enqueueDelivery(ctx, tx, runID, "continue:"+decimal(num(run["revision"])+1), at); e != nil {
				return nil, e
			}
		}
		if num(stats["pending"]) == 0 {
			if _, e = tx.Exec(ctx, `UPDATE operations_notices_v1 SET state='delivered',updated_at=$2 WHERE id=$1 AND state IN ('queued','delivering')`, runID, s.now()); e != nil {
				return nil, e
			}
		}
		run, e = s.runWithin(ctx, tx, runID, false)
		if e != nil {
			return nil, e
		}
		view, e := s.runView(ctx, tx, run)
		return Object{"run": view}, e
	})
}
func (s *Service) Deliver(ctx context.Context, runID string) (Object, error) {
	if !uuidOK(runID) {
		return nil, invalidInput()
	}
	processed := 0
	var executionError error
	for ; processed < deliveryPageSize; processed++ {
		if ctx.Err() != nil {
			break
		}
		claim, e := s.claim(ctx, runID)
		if e != nil {
			executionError = e
			break
		}
		if claim == nil {
			break
		}
		if claim.processed {
			continue
		}
		content := obj(claim.config["content"])
		authorize := func(c context.Context) error {
			if ctx.Err() != nil {
				return failure("operations_messaging_execution_interrupted")
			}
			return s.assertSubmission(c, claim)
		}
		result, e := s.Mail.Submit(ctx, MailRequest{AccountID: claim.accountID, MessageID: claim.messageID, SenderKey: str(claim.config["senderKey"]), Subject: str(content["title"]), Title: str(content["title"]), Paragraphs: regexp.MustCompile(`\n\s*\n`).Split(str(content["body"]), -1), Language: "zh-CN", Authorize: authorize})
		if e != nil {
			code := "operations_messaging_submission_unconfirmed"
			result = ProviderResult{Submission: Submission{Submission: "unknown", Code: &code}}
		}
		// The network attempt may have completed after the worker stop signal. Record
		// its real result before returning, using a bounded independent commit scope.
		receiptCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		_, e = s.settle(receiptCtx, claim, result)
		cancel()
		if e != nil {
			return nil, e
		}
	}
	if executionError != nil {
		code := fault.Code(executionError)
		if !contains([]string{"operations_messaging_paused", "operations_messaging_stopped", "operations_messaging_expired", "operations_messaging_version_changed", "operations_messaging_approval_unavailable", "operations_permission_denied", "business_admin_denied", "operations_authorization_unavailable"}, code) {
			return nil, executionError
		}
		_, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
			if _, e := s.runWithin(ctx, tx, runID, true); e != nil {
				return false, e
			}
			state := "blocked"
			switch code {
			case "operations_messaging_paused":
				state = "paused"
			case "operations_messaging_expired":
				state = "expired"
			case "operations_messaging_stopped", "operations_messaging_version_changed":
				state = "cancelled"
			}
			if _, e := tx.Exec(ctx, "UPDATE operations_messaging_runs_v1 SET state=$2,error_code=$3,revision=revision+1,updated_at=$4 WHERE id=$1", runID, state, code, s.now()); e != nil {
				return false, e
			}
			if code == "operations_messaging_expired" {
				if _, e := tx.Exec(ctx, `UPDATE operations_messaging_recipients_v1 SET state='skipped',retryable=false,retry_at=NULL,error_code=$2,completed_at=$3,updated_at=$3 WHERE run_id=$1 AND (state IN ('pending','blocked') OR state='failed' AND retryable)`, runID, code, s.now()); e != nil {
					return false, e
				}
			}
			return true, nil
		})
		if e != nil {
			return nil, e
		}
		row, e := s.runWithin(ctx, s.Pool, runID, false)
		if e != nil {
			return nil, e
		}
		view, e := s.runView(ctx, s.Pool, row)
		return Object{"processed": processed, "run": view}, e
	}
	finalCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, e := s.finalize(finalCtx, runID)
	if e != nil {
		return nil, e
	}
	result["processed"] = processed
	return result, nil
}
