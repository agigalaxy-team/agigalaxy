package credentials

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func (s *Service) recheckRow(ctx context.Context, tx pgx.Tx, r row, force bool) (row, error) {
	if r.withdrawn != nil || r.jws == nil {
		return r, nil
	}
	m, e := s.Verify(*r.jws)
	if e != nil {
		status, _ := json.Marshal(Object{"state": "unknown", "source": nil, "checkedAt": iso(s.now()), "validUntil": nil, "reason": "signature-not-current"})
		updated, e := scan(tx.QueryRow(ctx, "UPDATE account_external_credentials_v1 SET checked_at=$3,revocation=$4 WHERE id=$1 AND account_id=$2 AND withdrawn_at IS NULL RETURNING "+columns, r.id, r.account, s.now(), status))
		if errors.Is(e, pgx.ErrNoRows) {
			return s.own(ctx, tx, r.account, r.id, false)
		}
		return updated, e
	}
	revocation := s.revocation(ctx, m, force)
	metadata, _ := json.Marshal(m)
	status, _ := json.Marshal(revocation)
	updated, e := scan(tx.QueryRow(ctx, "UPDATE account_external_credentials_v1 SET metadata=$3,revocation=$4,checked_at=$5 WHERE id=$1 AND account_id=$2 AND withdrawn_at IS NULL RETURNING "+columns, r.id, r.account, metadata, status, s.now()))
	if errors.Is(e, pgx.ErrNoRows) {
		return s.own(ctx, tx, r.account, r.id, false)
	}
	return updated, e
}
func (s *Service) RecheckWithin(ctx context.Context, tx pgx.Tx, account, id string) (Object, error) {
	r, e := s.own(ctx, tx, account, id, false)
	if e != nil {
		return nil, e
	}
	r, e = s.recheckRow(ctx, tx, r, true)
	if e != nil {
		return nil, e
	}
	p, e := s.principal(ctx, tx, account)
	if e != nil {
		return nil, e
	}
	return s.view(r, p)
}
func (s *Service) WithdrawWithin(ctx context.Context, tx pgx.Tx, account, id string) (Object, error) {
	if _, e := s.own(ctx, tx, account, id, false); e != nil {
		return nil, e
	}
	_, e := tx.Exec(ctx, "UPDATE account_external_credentials_v1 SET credential_jws=NULL,metadata=metadata-'vc',withdrawn_at=COALESCE(withdrawn_at,$3) WHERE account_id=$1 AND id=$2", account, id, s.now())
	if e != nil {
		return nil, e
	}
	return Object{"id": id, "withdrawn": true, "issuerRevoked": false}, nil
}
func (s *Service) SupportedConditions() []Object {
	out := []Object{}
	for _, issuer := range s.config.Issuers {
		if issuer.Revocation != nil {
			for _, condition := range issuer.Conditions {
				out = append(out, Object{"kind": "external-credential", "issuerId": issuer.ID, "conditionId": condition.ID, "label": condition.Label, "issuerName": issuer.Name})
			}
		}
	}
	return out
}
func (s *Service) HasConditionWithin(ctx context.Context, tx pgx.Tx, account, issuerID, conditionID string) (bool, error) {
	if !uuidPattern.MatchString(account) {
		return false, nil
	}
	issuer := s.issuerID(issuerID)
	found := false
	if issuer != nil && issuer.Revocation != nil {
		for _, condition := range issuer.Conditions {
			if condition.ID == conditionID {
				found = true
			}
		}
	}
	if !found {
		return false, nil
	}
	p, e := s.principal(ctx, tx, account)
	if e != nil {
		return false, e
	}
	rows, e := tx.Query(ctx, "SELECT "+columns+" FROM account_external_credentials_v1 WHERE account_id=$1 AND issuer_id=$2 AND withdrawn_at IS NULL FOR SHARE", account, issuerID)
	if e != nil {
		return false, e
	}
	selected := []row{}
	for rows.Next() {
		r, e := scan(rows)
		if e != nil {
			rows.Close()
			return false, e
		}
		selected = append(selected, r)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return false, e
	}
	for _, r := range selected {
		v, e := s.view(r, p)
		if e != nil {
			return false, e
		}
		if contains(v["eligibility"].(Object)["conditionIds"].([]string), conditionID) {
			return true, nil
		}
	}
	return false, nil
}

// RefreshDue is explicit bounded API maintenance, never a constructor timer.
// The original API role owns this work; the evidence worker has no VC grants.
func (s *Service) RefreshDue(ctx context.Context, pool *pgxpool.Pool, limit int) (Object, error) {
	if limit == 0 {
		limit = 32
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 100 {
		limit = 100
	}
	rows, e := pool.Query(ctx, "SELECT "+columns+" FROM account_external_credentials_v1 WHERE withdrawn_at IS NULL AND checked_at<$1 ORDER BY checked_at,id LIMIT $2", s.now().Add(-60*time.Second), limit)
	if e != nil {
		return nil, e
	}
	selected := []row{}
	for rows.Next() {
		r, e := scan(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		selected = append(selected, r)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	checked := 0
	for _, r := range selected {
		if ctx.Err() != nil {
			break
		}
		_, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (row, error) { return s.recheckRow(ctx, tx, r, false) })
		if e != nil {
			return nil, e
		}
		checked++
	}
	return Object{"checked": checked}, nil
}
