package discovery

import (
	"context"
	"errors"
	"math"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Store struct {
	Pool        *pgxpool.Pool
	Endpoint    string
	Now         func() time.Time
	indexCursor atomic.Int32
}

func (s *Store) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC().Truncate(time.Second)
	}
	return time.Now().UTC().Truncate(time.Second)
}
func (s *Store) Initialize(ctx context.Context) error {
	_, e := s.Pool.Exec(ctx, "INSERT INTO discovery_index_control_v1(endpoint) VALUES($1) ON CONFLICT DO NOTHING", s.Endpoint)
	return e
}
func (s *Store) Enqueue(ctx context.Context, r Reference) error {
	if _, e := ItemKey(r); e != nil {
		return e
	}
	_, e := s.Pool.Exec(ctx, `INSERT INTO discovery_index_outbox_v1(endpoint,kind,source_id) VALUES($1,$2,$3) ON CONFLICT(endpoint,kind,source_id) DO UPDATE SET generation=discovery_index_outbox_v1.generation+1,state='pending',next_attempt_at=$4,updated_at=$4`, s.Endpoint, r.Kind, r.ID, s.now())
	return e
}
func (s *Store) Reconcile(ctx context.Context, r Reference) (bool, error) {
	if _, e := ItemKey(r); e != nil {
		return false, e
	}
	tag, e := s.Pool.Exec(ctx, `INSERT INTO discovery_index_outbox_v1(endpoint,kind,source_id) VALUES($1,$2,$3) ON CONFLICT(endpoint,kind,source_id) DO UPDATE SET generation=discovery_index_outbox_v1.generation+1,next_attempt_at=$4,updated_at=$4 WHERE discovery_index_outbox_v1.state='applied' AND discovery_index_outbox_v1.generation=discovery_index_outbox_v1.applied_generation`, s.Endpoint, r.Kind, r.ID, s.now())
	return e == nil && tag.RowsAffected() == 1, e
}

type IndexClaim struct {
	Reference
	Generation, AppliedGeneration int64
	State, LeaseID                string
	Attempts                      int
}

func (s *Store) ClaimIndex(ctx context.Context) (*IndexClaim, error) {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(context.Background())
	claim := IndexClaim{}
	e = tx.QueryRow(ctx, `SELECT kind,source_id::text,generation,applied_generation,state,attempts FROM discovery_index_outbox_v1 WHERE endpoint=$1 AND next_attempt_at<=$2 AND (state IN ('pending','failed') OR state='leased' AND lease_until<=$2 OR state='applied' AND generation>applied_generation) ORDER BY ((CASE WHEN state='applied' THEN 2 WHEN applied_generation=0 THEN 0 ELSE 1 END-$3::integer+3)%3),next_attempt_at,kind,source_id LIMIT 1 FOR UPDATE SKIP LOCKED`, s.Endpoint, s.now(), s.indexCursor.Load()).Scan(&claim.Kind, &claim.ID, &claim.Generation, &claim.AppliedGeneration, &claim.State, &claim.Attempts)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	claim.LeaseID = uuid.NewString()
	if _, e = tx.Exec(ctx, `UPDATE discovery_index_outbox_v1 SET state='leased',lease_id=$4,lease_until=$5,attempts=attempts+1 WHERE endpoint=$1 AND kind=$2 AND source_id=$3`, s.Endpoint, claim.Kind, claim.ID, claim.LeaseID, s.now().Add(time.Minute)); e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	switch {
	case claim.State == "applied":
		s.indexCursor.Store(0)
	case claim.AppliedGeneration == 0:
		s.indexCursor.Store(1)
	default:
		s.indexCursor.Store(2)
	}
	return &claim, nil
}
func (s *Store) QueueExpired(ctx context.Context, limit int) error {
	if limit < 1 || limit > 1000 {
		return invalid()
	}
	_, e := s.Pool.Exec(ctx, `UPDATE discovery_index_outbox_v1 SET generation=generation+1,state='pending',next_attempt_at=$2,updated_at=$2 WHERE (endpoint,kind,source_id) IN (SELECT endpoint,kind,source_id FROM discovery_index_outbox_v1 WHERE endpoint=$1 AND state='applied' AND source_expires_at<=$2 LIMIT $3)`, s.Endpoint, s.now(), limit)
	return e
}
func (s *Store) CompleteIndex(ctx context.Context, claim IndexClaim, version *string, expiresAt *int64, code *string) error {
	var expiry any
	if expiresAt != nil {
		expiry = time.Unix(*expiresAt, 0).UTC()
	}
	next := s.now()
	if code != nil {
		next = next.Add(time.Duration(math.Min(300, math.Pow(2, float64(min(claim.Attempts+1, 8))))) * time.Second)
	}
	_, e := s.Pool.Exec(ctx, `UPDATE discovery_index_outbox_v1 SET state=CASE WHEN $6::text IS NOT NULL THEN 'failed' WHEN generation=$5 THEN 'applied' ELSE 'pending' END,applied_generation=CASE WHEN $6::text IS NULL THEN $5 ELSE applied_generation END,indexed_version=CASE WHEN $6::text IS NULL THEN $7 ELSE indexed_version END,source_expires_at=CASE WHEN $6::text IS NULL THEN $9::timestamptz ELSE source_expires_at END,last_error=$6,lease_id=NULL,lease_until=NULL,next_attempt_at=$8 WHERE endpoint=$1 AND kind=$2 AND source_id=$3 AND lease_id=$4`, s.Endpoint, claim.Kind, claim.ID, claim.LeaseID, claim.Generation, code, version, next, expiry)
	return e
}
