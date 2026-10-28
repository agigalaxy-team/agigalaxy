package failureaudit

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"strconv"
	"time"
)

// NewPostgresWriter uses the existing audit_events/deletion_requests protocol;
// it does not retry transactions. Replay belongs only to the durable spool's
// original request/action key, never to any business command.
func NewPostgresWriter(pool *pgxpool.Pool, endpoint string) Writer {
	return PostgresWriter(pool, endpoint, time.Now)
}
func PostgresWriter(pool *pgxpool.Pool, endpoint string, now func() time.Time) Writer {
	if now == nil {
		now = time.Now
	}
	return func(ctx context.Context, input Event) (Result, error) {
		event, e := normalize(input, now())
		if e != nil {
			return Result{}, e
		}
		a := event.Actor
		if a != nil && a.Authentication != nil {
			auth := a.Authentication
			audience := auth.Audience
			if auth.Version == 2 {
				audience = auth.Endpoint
			}
			if audience != endpoint {
				return Result{}, safeError("failure_audit_audience_mismatch")
			}
		}
		result, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Result, error) {
			if _, e := tx.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"); e != nil {
				return Result{}, safeError("failure_audit_delivery_failed")
			}
			if _, e := tx.Exec(ctx, "LOCK TABLE audit_events,deletion_requests IN ROW EXCLUSIVE MODE"); e != nil {
				return Result{}, safeError("failure_audit_delivery_failed")
			}
			var subject, binding, authentication any
			if a != nil {
				subject = a.SubjectID
				binding = a.BindingID
				if a.Authentication != nil {
					authentication = encode(a.Authentication)
				}
				var exists bool
				e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM deletion_requests WHERE subject_id=$1 AND state IN ('partial','primary-erased') AND (execution_result->'audit'->>'until')::bigint<=$2)`, a.SubjectID, now().Unix()).Scan(&exists)
				if e != nil {
					return Result{}, safeError("failure_audit_delivery_failed")
				}
				if exists {
					return Result{State: "suppressed-by-deletion"}, nil
				}
			}
			action := "http.failed"
			if event.Status < 500 {
				action = "http.rejected"
			}
			rows, e := tx.Query(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,
      context_version,client_id,audience,http_request_id,idempotency_key,
      caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes,created_at,scope,credential_scopes)
      SELECT COALESCE($7::text,'http-request'),$1,$2,$3::text,$4,0,'galaxy-http-api',$5,$3::text::uuid,$3::text,
        CASE WHEN $9::jsonb IS NULL THEN b.id ELSE $6::uuid END,
        CASE WHEN $9::jsonb IS NULL THEN ch.payload->>'installationId' ELSE $9::jsonb->>'clientId' END,
        CASE WHEN $9::jsonb IS NULL THEN b.audience ELSE $9::jsonb->>'audience' END,
        CASE WHEN $9::jsonb IS NULL THEN b.scopes ELSE $9::jsonb->'bindingScopes' END,
        $8::timestamptz,$9::jsonb->>'scope',$9::jsonb->'credentialScopes'
      FROM (SELECT 1) seed LEFT JOIN bindings b ON b.id=$6::uuid AND b.subject_id=$7
      LEFT JOIN binding_challenges ch ON ch.id=b.challenge_id
      ON CONFLICT (http_request_id,action) WHERE action IN ('http.rejected','http.failed') DO NOTHING RETURNING sequence`, action, event.Route, event.RequestID, statusString(event.Status), endpoint, binding, subject, event.ObservedAt, authentication)
			if e != nil {
				return Result{}, safeError("failure_audit_delivery_failed")
			}
			defer rows.Close()
			n := 0
			for rows.Next() {
				n++
			}
			if rows.Err() != nil || n > 1 {
				return Result{}, safeError("failure_audit_delivery_failed")
			}
			return Result{State: "recorded"}, nil
		})
		if err != nil {
			return Result{}, safeError("failure_audit_delivery_failed")
		}
		return result, nil
	}
}

func statusString(status int) string { return strconv.Itoa(status) }
