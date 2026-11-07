package communitygrowth

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// Source updates, rule publishing and reconciliation share the endpoint lock.
// Activation only takes it when idle, since a forum transaction can already
// hold its business row while it enters the growth update.
func (s *Service) lockLedger(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended($1,734912771))`, s.Endpoint)
	return err
}

func (s *Service) prepareLedgerWithin(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `INSERT INTO community_growth_ledger_state_v1(endpoint,prepared_at)
		VALUES($1,$2) ON CONFLICT(endpoint) DO NOTHING`, s.Endpoint, s.now())
	return err
}

func (s *Service) lockGrowthRuleWithin(ctx context.Context, tx pgx.Tx, rule string) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,734912772))`, s.Endpoint+":"+rule)
	return err
}

// An award belongs to the source row and never changes on a later revision.
// A disabled rule records its selected version but contributes no experience.
func (s *Service) awardWithin(ctx context.Context, tx pgx.Tx, id, rule string, deferred bool) (bool, error) {
	// A rule publisher may already be waiting for another source transaction.
	// Keep this business write moving and let the normal worker finish its award.
	var locked bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,734912772))`, s.Endpoint+":"+rule).Scan(&locked); err != nil || !locked {
		return false, err
	}
	tag, err := tx.Exec(ctx, `UPDATE community_growth_sources_v1 x
		SET growth_experience=CASE WHEN (h.snapshot->>'enabled')::boolean THEN (h.snapshot->>'experience')::bigint END,
		    growth_rule_version=h.version, growth_basis=CASE WHEN x.occurred_at<st.prepared_at THEN 'baseline' ELSE 'version' END,
		    growth_earned_at=x.occurred_at,
		    updated_at=CASE WHEN $3 THEN clock_timestamp() ELSE x.updated_at END
		FROM community_growth_ledger_state_v1 st, community_growth_rule_history_v1 h
		WHERE x.endpoint=$1 AND x.id=$2 AND x.active AND x.growth_rule_version IS NULL
		  AND st.endpoint=x.endpoint
		  AND (st.activated_at IS NOT NULL OR (x.growth_basis IS NULL AND x.occurred_at>=st.prepared_at))
		  AND h.endpoint=x.endpoint AND h.rule_key=x.rule_key AND h.snapshot->>'source_kind'=x.source_kind
		  AND h.version=(SELECT v.version FROM community_growth_rule_history_v1 v
		    WHERE v.endpoint=x.endpoint AND v.rule_key=x.rule_key
		      AND (v.created_at<=CASE WHEN x.occurred_at<st.prepared_at THEN st.activated_at ELSE x.occurred_at END OR v.version=1)
		    ORDER BY v.version DESC LIMIT 1)`, s.Endpoint, id, deferred)
	return tag.RowsAffected() != 0, err
}

func (s *Service) reconcilePendingAwardsWithin(ctx context.Context, tx pgx.Tx, limit int) (pendingCount, completed int, err error) {
	rows, err := tx.Query(ctx, `SELECT x.id::text,x.rule_key FROM community_growth_sources_v1 x
		JOIN community_growth_ledger_state_v1 st ON st.endpoint=x.endpoint
		WHERE x.endpoint=$1 AND x.active AND x.growth_rule_version IS NULL AND x.source_kind NOT IN ('evaluation','honor')
		  AND (st.activated_at IS NOT NULL OR (x.growth_basis IS NULL AND x.occurred_at>=st.prepared_at))
		ORDER BY x.id LIMIT $2 FOR UPDATE OF x SKIP LOCKED`, s.Endpoint, limit)
	if err != nil {
		return 0, 0, err
	}
	type pendingAward struct{ id, rule string }
	pending, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (pendingAward, error) {
		var a pendingAward
		err := row.Scan(&a.id, &a.rule)
		return a, err
	})
	if err != nil {
		return 0, 0, err
	}
	for _, a := range pending {
		awarded, err := s.awardWithin(ctx, tx, a.id, a.rule, true)
		if err != nil {
			return 0, 0, err
		}
		if awarded {
			completed++
		}
	}
	return len(pending), completed, nil
}

// ActivateGrowthLedger freezes the legacy read basis and switches future reads
// and writes in one transaction. It is safe to call again after an unknown result.
func (s *Service) ActivateGrowthLedger(ctx context.Context) (Object, error) {
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var locked bool
		if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1,734912771))`, s.Endpoint).Scan(&locked); err != nil {
			return nil, err
		}
		if !locked {
			return nil, fault.New("community_growth_ledger_reconciling", 409)
		}
		var prepared time.Time
		var reconciled, activated *time.Time
		if err := tx.QueryRow(ctx, `SELECT prepared_at,reconciled_at,activated_at FROM community_growth_ledger_state_v1
			WHERE endpoint=$1`, s.Endpoint).Scan(&prepared, &reconciled, &activated); err != nil && !noRows(err) {
			return nil, err
		}
		if activated != nil {
			return Object{"preparedAt": prepared, "reconciledAt": reconciled, "activatedAt": activated}, nil
		}
		var dirty bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_growth_dirty_objects_v1 WHERE endpoint=$1)`, s.Endpoint).Scan(&dirty); err != nil {
			return nil, err
		}
		if reconciled == nil || dirty {
			return nil, fault.New("community_growth_ledger_reconciling", 409)
		}
		at := s.now().Truncate(time.Microsecond)
		tag, err := tx.Exec(ctx, `WITH unresolved AS (
			SELECT x.id,x.occurred_at,
			  CASE WHEN x.growth_basis IS NULL AND x.occurred_at>=$2 THEN 'version'
			       WHEN x.active AND r.enabled AND x.growth_basis='legacy' THEN 'legacy'
			       ELSE 'baseline' END AS basis,
			  CASE WHEN x.growth_basis IS NULL AND x.occurred_at>=$2 THEN historical.version ELSE r.version END AS version,
			  CASE WHEN x.growth_basis IS NULL AND x.occurred_at>=$2
			       THEN CASE WHEN (historical.snapshot->>'enabled')::boolean THEN (historical.snapshot->>'experience')::bigint END
			       WHEN r.enabled THEN r.experience END AS experience
			FROM community_growth_sources_v1 x
			JOIN community_growth_rules_v1 r ON r.endpoint=x.endpoint AND r.rule_key=x.rule_key AND r.source_kind=x.source_kind
			LEFT JOIN LATERAL (
			  SELECT h.version,h.snapshot FROM community_growth_rule_history_v1 h
			  WHERE h.endpoint=x.endpoint AND h.rule_key=x.rule_key AND (h.created_at<=x.occurred_at OR h.version=1)
			  ORDER BY h.version DESC LIMIT 1
			) historical ON x.growth_basis IS NULL AND x.occurred_at>=$2
			WHERE x.endpoint=$1 AND x.growth_rule_version IS NULL
			  AND (x.active OR (x.growth_basis='legacy' AND x.source_kind IN ('post','reply','like')))
			)
			UPDATE community_growth_sources_v1 x
			SET growth_experience=u.experience,growth_rule_version=u.version,growth_basis=u.basis,growth_earned_at=u.occurred_at
			FROM unresolved u WHERE x.endpoint=$1 AND x.id=u.id AND u.version IS NOT NULL`, s.Endpoint, prepared)
		if err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `UPDATE community_growth_ledger_state_v1 SET activated_at=$2 WHERE endpoint=$1`, s.Endpoint, at); err != nil {
			return nil, err
		}
		return Object{"preparedAt": prepared, "reconciledAt": reconciled, "activatedAt": at, "resolvedAwards": tag.RowsAffected()}, nil
	})
}
