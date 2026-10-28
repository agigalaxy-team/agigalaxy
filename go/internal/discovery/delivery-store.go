package discovery

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type DeliveryClaim struct {
	EventID, Target, LeaseID string
	Attempts                 int
	SubmissionStarted        bool
}

func (s *Store) ClaimDelivery(ctx context.Context) (*DeliveryClaim, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	row := DeliveryClaim{}
	e = tx.QueryRow(ctx, `SELECT event_id::text,target,attempts,submission_started FROM discovery_delivery_outbox_v1 WHERE endpoint=$1 AND next_attempt_at<=$2 AND (state IN ('pending','failed','result-unknown') OR state='leased' AND lease_until<=$2) ORDER BY next_attempt_at LIMIT 1 FOR UPDATE SKIP LOCKED`, s.Endpoint, s.now()).Scan(&row.EventID, &row.Target, &row.Attempts, &row.SubmissionStarted)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	row.LeaseID = uuid.NewString()
	if _, e = tx.Exec(ctx, `UPDATE discovery_delivery_outbox_v1 SET state='leased',lease_id=$4,lease_until=$5,attempts=attempts+1 WHERE endpoint=$1 AND event_id=$2 AND target=$3`, s.Endpoint, row.EventID, row.Target, row.LeaseID, s.now().Add(time.Minute)); e != nil {
		return nil, e
	}
	return &row, tx.Commit(ctx)
}
func (s *Store) DeliveryEvent(ctx context.Context, row DeliveryClaim) (Object, error) {
	return rowObject(ctx, s.Pool, "SELECT payload FROM discovery_usage_events_v1 WHERE endpoint=$1 AND id=$2", s.Endpoint, row.EventID)
}
func (s *Store) BeginSubmission(ctx context.Context, row DeliveryClaim) (bool, error) {
	tag, e := s.Pool.Exec(ctx, "UPDATE discovery_delivery_outbox_v1 SET submission_started=true WHERE endpoint=$1 AND event_id=$2 AND target=$3 AND lease_id=$4", s.Endpoint, row.EventID, row.Target, row.LeaseID)
	return e == nil && tag.RowsAffected() == 1, e
}
func (s *Store) CompleteDelivery(ctx context.Context, row DeliveryClaim, state string, code *string) error {
	if state != "delivered" && state != "pending" && state != "result-unknown" && state != "excluded" {
		return invalid()
	}
	next := s.now().Add(time.Duration(math.Min(300, math.Pow(2, float64(min(row.Attempts+1, 8))))) * time.Second)
	_, e := s.Pool.Exec(ctx, `UPDATE discovery_delivery_outbox_v1 SET state=$5,last_error=$6,submission_started=CASE WHEN $6='discovery_engine_authorization_failed' THEN false ELSE submission_started END,lease_id=NULL,lease_until=NULL,next_attempt_at=$7 WHERE endpoint=$1 AND event_id=$2 AND target=$3 AND lease_id=$4`, s.Endpoint, row.EventID, row.Target, row.LeaseID, state, code, next)
	return e
}
func (s *Store) Status(ctx context.Context) (Object, error) {
	deliveries := []Object{}
	rows, e := s.Pool.Query(ctx, "SELECT target,state,count(*)::int FROM discovery_delivery_outbox_v1 WHERE endpoint=$1 GROUP BY target,state", s.Endpoint)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var target, state string
		var count int
		if e = rows.Scan(&target, &state, &count); e != nil {
			rows.Close()
			return nil, e
		}
		deliveries = append(deliveries, Object{"target": target, "state": state, "count": count})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	index := []Object{}
	rows, e = s.Pool.Query(ctx, "SELECT CASE WHEN state='applied' AND generation>applied_generation THEN 'pending' ELSE state END AS state,count(*)::int FROM discovery_index_outbox_v1 WHERE endpoint=$1 GROUP BY 1", s.Endpoint)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var state string
		var count int
		if e = rows.Scan(&state, &count); e != nil {
			rows.Close()
			return nil, e
		}
		index = append(index, Object{"state": state, "count": count})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	return Object{"deliveries": deliveries, "index": index, "checkedAt": s.now().Unix()}, nil
}
