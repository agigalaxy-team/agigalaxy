package historyv2

import (
	"context"
	"github.com/jackc/pgx/v5"
	"time"
)

const candidateCasesSQL = `SELECT c.id::text FROM cases c
 WHERE ($2::uuid IS NULL OR c.id>$2) AND c.state<>'withdrawn' AND ($1::text IS NULL OR c.subject_id=$1
 OR EXISTS(SELECT 1 FROM case_events e WHERE e.case_id=c.id AND e.subject_id=$1)
 OR EXISTS(SELECT 1 FROM verification_objects v WHERE v.case_id=c.id AND v.subject_id=$1)
 OR EXISTS(SELECT 1 FROM task_requests t JOIN task_participations p ON p.task_id=t.id WHERE t.case_id=c.id AND p.subject_id=$1))
 AND (NOT $3::boolean OR c.subject_id=$4 OR EXISTS(SELECT 1 FROM case_events e WHERE e.case_id=c.id AND e.subject_id=$4)
 OR EXISTS(SELECT 1 FROM verification_objects v WHERE v.case_id=c.id)
 OR EXISTS(SELECT 1 FROM task_requests t WHERE t.case_id=c.id)
 OR EXISTS(SELECT 1 FROM capsule_uses_v2 u WHERE u.case_id=c.id)
 OR EXISTS(SELECT 1 FROM evidence_submissions e JOIN proofs p ON p.evidence_id=e.id WHERE e.case_id=c.id)
 OR EXISTS(SELECT 1 FROM case_events e JOIN consents g ON g.id=e.consent_id AND g.subject_id=e.subject_id JOIN bindings b ON b.id=g.binding_id
 WHERE e.case_id=c.id AND octet_length(e.payload_text)>0 AND g.revoked_at IS NULL AND b.revoked_at IS NULL AND g.expires_at>$5 AND b.expires_at>$5
 AND g.intent->>'action'='case.teaser.publish' AND g.intent->>'objectId'=e.id::text AND g.intent->>'recipient'=$6 AND g.intent->>'payloadHash'=e.payload_hash
 AND (g.intent->>'subjectId'=$4 OR (NOT EXISTS(SELECT 1 FROM deletion_requests d WHERE d.subject_id=e.subject_id AND d.state IN ('requested','review-needed','approved','partial','primary-erased'))
 AND ((g.intent->>'visibility'='Public' AND g.intent->>'purpose'='public-profile') OR (g.intent->>'visibility' IN ('Private','Hub-scoped') AND g.intent->'viewers' ? $4))))))
 ORDER BY c.id LIMIT 100`
const candidateTasksSQL = `SELECT t.id::text FROM task_requests t WHERE ($2::uuid IS NULL OR t.id>$2) AND ($1::text IS NULL OR t.requester_id=$1 OR EXISTS(SELECT 1 FROM task_participations p WHERE p.task_id=t.id AND p.subject_id=$1)) ORDER BY t.id LIMIT 100`

func scanIDs(ctx context.Context, tx pgx.Tx, read func(any) ([]string, error), visit func(string) error) error {
	var after any
	for {
		page, e := read(after)
		if e != nil {
			return e
		}
		for _, id := range page {
			if e = visit(id); e != nil {
				return e
			}
		}
		if len(page) < 100 {
			return nil
		}
		after = page[len(page)-1]
	}
}
func ids(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]string, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			return nil, e
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

type taskPublication struct{ ID, Subject, At string }

func rootTaskEvent(ctx context.Context, tx pgx.Tx, id string) (*taskPublication, error) {
	rows, e := tx.Query(ctx, `SELECT e.id::text,e.subject_id,e.created_at FROM task_requests t JOIN task_events e ON e.id=t.root_event_id WHERE t.id=$1`, id)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var r taskPublication
	var created time.Time
	if e = rows.Scan(&r.ID, &r.Subject, &created); e != nil {
		return nil, e
	}
	r.At = created.UTC().Format("2006-01-02T15:04:05.000Z")
	return &r, nil
}
