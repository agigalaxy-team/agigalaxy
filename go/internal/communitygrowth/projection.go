package communitygrowth

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
	"time"
)

type Source struct {
	Kind, ID, RuleKey, AccountID, Title, ObjectKind, ObjectID string
	Domains                                                   []string
	Active                                                    bool
	Revision                                                  int64
	OccurredAt                                                time.Time
}

// RecordSourceWithin must be called in the originating business transaction.
// A stale revision is ignored; an equal revision with different facts is rejected.
func (s *Service) RecordSourceWithin(ctx context.Context, tx pgx.Tx, x Source) error {
	if x.Kind == "" || x.ID == "" || x.RuleKey == "" || x.AccountID == "" || x.Revision < 1 || x.OccurredAt.IsZero() {
		return invalid()
	}
	x.OccurredAt = x.OccurredAt.UTC().Truncate(time.Microsecond)
	if x.Domains == nil {
		x.Domains = []string{}
	}
	var exists bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM community_accounts WHERE endpoint=$1 AND id=$2)`, s.Endpoint, x.AccountID).Scan(&exists); e != nil {
		return e
	}
	if !exists {
		return fault.New("community_growth_account_not_found", 404)
	}
	if e := s.ensureDefaults(ctx, tx); e != nil {
		return e
	}
	var kind string
	if !(x.Kind == "honor" && x.RuleKey == "honor") && !(x.Kind == "evaluation" && x.RuleKey == "evaluation") {
		if e := tx.QueryRow(ctx, `SELECT source_kind FROM community_growth_rules_v1 WHERE endpoint=$1 AND rule_key=$2`, s.Endpoint, x.RuleKey).Scan(&kind); e != nil {
			return e
		}
		if kind != x.Kind {
			return invalid()
		}
	}
	tag, e := tx.Exec(ctx, `INSERT INTO community_growth_sources_v1(endpoint,source_kind,source_id,rule_key,account_id,domains,title,object_kind,object_id,active,revision,occurred_at,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(endpoint,source_kind,source_id,rule_key,account_id) DO UPDATE
 SET domains=EXCLUDED.domains,title=EXCLUDED.title,object_kind=EXCLUDED.object_kind,object_id=EXCLUDED.object_id,active=EXCLUDED.active,revision=EXCLUDED.revision,occurred_at=EXCLUDED.occurred_at,updated_at=EXCLUDED.updated_at
 WHERE community_growth_sources_v1.revision<EXCLUDED.revision`, s.Endpoint, x.Kind, x.ID, x.RuleKey, x.AccountID, x.Domains, x.Title, x.ObjectKind, x.ObjectID, x.Active, x.Revision, x.OccurredAt, s.now())
	if e != nil {
		return e
	}
	var revision int64
	var active bool
	var domains []string
	var occurred time.Time
	var title, objectKind, objectID string
	e = tx.QueryRow(ctx, `SELECT revision,active,domains,occurred_at,title,object_kind,object_id FROM community_growth_sources_v1 WHERE endpoint=$1 AND source_kind=$2 AND source_id=$3 AND rule_key=$4 AND account_id=$5`, s.Endpoint, x.Kind, x.ID, x.RuleKey, x.AccountID).Scan(&revision, &active, &domains, &occurred, &title, &objectKind, &objectID)
	if e != nil {
		return e
	}
	if revision == x.Revision && (title != x.Title || objectKind != x.ObjectKind || objectID != x.ObjectID || active != x.Active || jsonText(domains) != jsonText(x.Domains) || !occurred.Equal(x.OccurredAt)) {
		return fault.New("community_growth_source_revision_conflict", 409)
	}
	if tag.RowsAffected() > 0 && s.OnSourceWithin != nil {
		return s.OnSourceWithin(ctx, tx, x)
	}
	return nil
}
