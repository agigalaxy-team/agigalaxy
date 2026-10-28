package feedback

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Object = map[string]any

// Authorization is a trusted server-side port, never an actor/header supplied by
// a browser. It must revalidate the current identity and permission in this tx.
// Until the identity adapter is migrated, a nil implementation closes this path.
type Authorization interface {
	Account(context.Context, pgx.Tx, string, string) error
	Operator(context.Context, pgx.Tx, string, string, string) (Operator, error)
}
type Operator struct {
	ID, Role, RequestID string
	CanManage           bool
	operations          *operationsOperator
}
type Attachments interface {
	Bind(context.Context, pgx.Tx, string, string, string, []Reference, time.Time) error
	List(context.Context, pgx.Tx, string) ([]Object, error)
}
type Service struct {
	Pool        *pgxpool.Pool
	Endpoint    string
	Authority   Authorization
	Attachments Attachments
	// Tasks is explicitly injected only when this domain uses the Go transport.
	// Nil retains the original non-River path without touching queue tables.
	Tasks     TaskProducer
	RequestID string
	Now       func() time.Time
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Millisecond)
	}
	return time.Now().UTC().Truncate(time.Millisecond)
}
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (s *Service) account(ctx context.Context, tx pgx.Tx, id string) error {
	if !uuidPattern.MatchString(id) {
		return fault.New("official_account_login_required", 401)
	}
	if s.Authority == nil {
		return fault.New("official_account_unavailable", 503)
	}
	return s.Authority.Account(ctx, tx, s.Endpoint, id)
}
func (s *Service) operator(ctx context.Context, tx pgx.Tx, id, permission string) (Operator, error) {
	if s.Authority == nil {
		return Operator{}, fault.New("business_admin_unavailable", 503)
	}
	a, e := s.Authority.Operator(ctx, tx, s.Endpoint, id, permission)
	if e != nil {
		return a, e
	}
	if a.ID == "" || a.ID != id {
		return a, fault.New("business_admin_denied", 403)
	}
	if _, ok := s.operationsActor(a); ok {
		return a, nil
	}
	var issuer, subject string
	e = tx.QueryRow(ctx, "SELECT issuer,external_subject FROM operations_operator_principals_v1 WHERE operator_id=$1 AND endpoint=$2 FOR SHARE", a.ID, s.Endpoint).Scan(&issuer, &subject)
	if errors.Is(e, pgx.ErrNoRows) {
		return a, fault.New("business_admin_denied", 403)
	}
	return a, e
}
func (s *Service) Submit(ctx context.Context, account string, raw []byte) (Object, error) {
	x, e := ParseSubmission(raw)
	if e != nil {
		return nil, e
	}
	b, e := identity.Canonical(x)
	if e != nil {
		return nil, e
	}
	fingerprint := identity.Digest(b)
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912395))", s.Endpoint+":feedback-intake:"+account); e != nil {
			return nil, e
		}
		var id, hash string
		var at time.Time
		var deleted *time.Time
		e := tx.QueryRow(ctx, `SELECT id::text,request_hash,created_at,owner_deleted_at FROM operations_feedback_v1
		 WHERE endpoint=$1 AND account_id=$2 AND submission_operation_id=$3`, s.Endpoint, account, x.OperationID).Scan(&id, &hash, &at, &deleted)
		if e == nil {
			if hash != fingerprint {
				return nil, fault.New("feedback_operation_conflict", 409)
			}
			out := Object{"feedbackId": id, "operationId": x.OperationID, "submittedAt": iso(at), "replayed": true}
			if deleted != nil {
				out["deleted"] = true
			}
			return out, nil
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		now := s.now()
		var day, minute int
		e = tx.QueryRow(ctx, `SELECT count(*)::int,count(*) FILTER(WHERE created_at>$4)::int FROM operations_feedback_v1
		 WHERE endpoint=$1 AND account_id=$2 AND created_at>$3`, s.Endpoint, account, now.Add(-24*time.Hour), now.Add(-time.Minute)).Scan(&day, &minute)
		if e != nil {
			return nil, e
		}
		if minute > 0 {
			return nil, fault.New("feedback_rate_limited", 429)
		}
		if day >= 5 {
			return nil, fault.New("feedback_daily_limit", 429)
		}
		id = uuid.NewString()
		title := "使用反馈"
		if x.Title != nil {
			title = *x.Title
		} else {
			for _, line := range strings.Split(x.Body, "\n") {
				if strings.TrimSpace(line) != "" {
					title = prefix(strings.TrimSpace(line), 120)
					break
				}
			}
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_feedback_v1(id,endpoint,account_id,submission_operation_id,request_hash,title,body,
		 submitted_category,submitted_module,category,module,state,revision,created_at,updated_at)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9,'pending',1,$10,$10)`, id, s.Endpoint, account, x.OperationID, fingerprint, title, x.Body, x.Category, x.Module, now)
		if e != nil {
			return nil, e
		}
		if len(x.Attachments) > 0 {
			if s.Attachments == nil {
				return nil, fault.New("attachment_service_unavailable", 503)
			}
			if e = s.Attachments.Bind(ctx, tx, account, x.OperationID, id, x.Attachments, now); e != nil {
				return nil, e
			}
		}
		_, e = tx.Exec(ctx, `INSERT INTO operations_feedback_events_v1(id,feedback_id,endpoint,kind,operator_id,operation_id,revision,category,module,state,note,http_request_id,created_at)
		 VALUES($1,$2,$3,'submitted',NULL,$4,1,$5,$6,'pending',NULL,$8,$7)`, uuid.NewString(), id, s.Endpoint, x.OperationID, x.Category, x.Module, now, nullable(s.RequestID))
		if e != nil {
			return nil, e
		}
		return Object{"feedbackId": id, "operationId": x.OperationID, "submittedAt": iso(now), "replayed": false}, nil
	})
}
func (s *Service) SubmissionOperation(ctx context.Context, account, op string) (Object, error) {
	if !uuidPattern.MatchString(op) {
		return nil, invalid()
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		if e := s.account(ctx, tx, account); e != nil {
			return nil, e
		}
		var id string
		var at time.Time
		var deleted *time.Time
		e := tx.QueryRow(ctx, `SELECT id::text,created_at,owner_deleted_at FROM operations_feedback_v1 WHERE endpoint=$1 AND account_id=$2 AND submission_operation_id=$3`, s.Endpoint, account, op).Scan(&id, &at, &deleted)
		if errors.Is(e, pgx.ErrNoRows) {
			return Object{"state": "not-recorded", "operationId": op}, nil
		}
		if e != nil {
			return nil, e
		}
		return Object{"state": "recorded", "operationId": op, "feedbackId": id, "submittedAt": iso(at), "deleted": deleted != nil}, nil
	})
}
func (s *Service) record(ctx context.Context, tx pgx.Tx, a Operator, action, op string, selection, result Object) error {
	if proof, ok := s.operationsActor(a); ok {
		return proof.owner.domain.Record(ctx, tx, proof.actor, action, selection, result, nullable(op))
	}
	if a.RequestID == "" {
		a.RequestID = s.RequestID
	}
	b, e := json.Marshal(selection)
	if e != nil {
		return e
	}
	r, e := json.Marshal(result)
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at,actor_kind,execution_id,grant_id,actor_context)
	 VALUES($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,'business-operator',NULL,NULL,NULL)`, uuid.NewString(), s.Endpoint, a.ID, a.Role, action, nullable(op), nullable(a.RequestID), b, r, s.now())
	return e
}
