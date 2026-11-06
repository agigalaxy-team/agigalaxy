package discovery

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// A leased event cannot serialize remote changes after its lease expires. This
// dedicated connection keeps a relation lock until the request has returned and
// its revision is settled. Source writes do not take this advisory lock.
type feedbackStateClaim struct {
	FeedbackState
	attempts   int
	generation int64
	conn       *pgxpool.Conn
	lockKey    string
}

func (c *feedbackStateClaim) release() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var unlocked bool
	e := c.conn.QueryRow(ctx, "SELECT pg_advisory_unlock(hashtextextended($1,734912431))", c.lockKey).Scan(&unlocked)
	if e != nil || !unlocked {
		// Never return a connection still holding a session lock to the pool.
		_ = c.conn.Conn().Close(ctx)
	}
	c.conn.Release()
}

func (s *Store) claimFeedbackState(ctx context.Context) (*feedbackStateClaim, error) {
	rows, e := s.Pool.Query(ctx, `SELECT profile_id,item_key,feedback_type FROM discovery_feedback_state_v1
		WHERE endpoint=$1 AND delivery_generation>applied_generation AND next_attempt_at<=$2
		ORDER BY next_attempt_at,updated_at,profile_id,item_key,feedback_type LIMIT 32`, s.Endpoint, s.now())
	if e != nil {
		return nil, e
	}
	keys := []FeedbackState{}
	for rows.Next() {
		var key FeedbackState
		if e = rows.Scan(&key.ProfileID, &key.ItemKey, &key.Type); e != nil {
			rows.Close()
			return nil, e
		}
		keys = append(keys, key)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	for _, key := range keys {
		conn, e := s.Pool.Acquire(ctx)
		if e != nil {
			return nil, e
		}
		claim := &feedbackStateClaim{FeedbackState: key, conn: conn,
			lockKey: jsonString([]string{"discovery-feedback-state-v1", s.Endpoint, key.ProfileID, key.ItemKey, key.Type})}
		var locked bool
		if e = conn.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtextextended($1,734912431))", claim.lockKey).Scan(&locked); e != nil {
			// The server may have acquired the lock before the reply was lost.
			_ = conn.Conn().Close(context.Background())
			conn.Release()
			return nil, e
		}
		if !locked {
			conn.Release()
			continue
		}
		e = conn.QueryRow(ctx, `SELECT desired_active,revision,occurred_at,attempts,delivery_generation FROM discovery_feedback_state_v1
			WHERE endpoint=$1 AND profile_id=$2 AND item_key=$3 AND feedback_type=$4
			AND delivery_generation>applied_generation AND next_attempt_at<=$5`, s.Endpoint, key.ProfileID, key.ItemKey, key.Type, s.now()).
			Scan(&claim.Active, &claim.Revision, &claim.OccurredAt, &claim.attempts, &claim.generation)
		if errors.Is(e, pgx.ErrNoRows) {
			claim.release()
			continue
		}
		if e != nil {
			claim.release()
			return nil, e
		}
		return claim, nil
	}
	return nil, nil
}

func (s *Store) completeFeedbackState(ctx context.Context, claim *feedbackStateClaim, code *string) (bool, error) {
	next := s.now()
	if code != nil {
		next = next.Add(time.Duration(math.Min(300, math.Pow(2, float64(min(claim.attempts+1, 8))))) * time.Second)
	}
	// A source update may commit during the HTTP call. Settle only the revision
	// sent; newer desired state stays pending and will be read under this lock
	// by a later worker. Neither failure nor success overwrites its retry state.
	tag, e := claim.conn.Exec(ctx, `UPDATE discovery_feedback_state_v1 SET
		applied_revision=CASE WHEN $6::text IS NULL THEN $5 ELSE applied_revision END,
        applied_generation=CASE WHEN $6::text IS NULL THEN $9 ELSE applied_generation END,
		attempts=attempts+1,next_attempt_at=$7,last_error=$6,updated_at=$8
		WHERE endpoint=$1 AND profile_id=$2 AND item_key=$3 AND feedback_type=$4 AND revision=$5 AND delivery_generation=$9`,
		s.Endpoint, claim.ProfileID, claim.ItemKey, claim.Type, claim.Revision, code, next, s.now(), claim.generation)
	return e == nil && tag.RowsAffected() == 1, e
}
