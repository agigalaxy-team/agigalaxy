package discovery

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// ReadTheme and ReadPolicy expose the owning service's exact current objects;
// they keep the same current read authorization as recommendation overview.
func (s *Recommendations) ReadTheme(ctx context.Context, actor Actor, id string) (Object, error) {
	if !validID(id) {
		return nil, recommendationInvalid()
	}
	business := s.business()
	if _, e := business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	row, e := rowObject(ctx, s.Pool, "SELECT to_jsonb(t) FROM operations_recommendation_themes_v1 t WHERE endpoint=$1 AND id=$2", s.Endpoint, id)
	if e != nil {
		return nil, e
	}
	if row == nil {
		return nil, qualityFailure("recommendation_theme_unavailable", 404)
	}
	if _, e = business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	return merge(Object{"theme": themeView(row)}, business.metadata()), nil
}
func (s *Recommendations) ReadPolicy(ctx context.Context, actor Actor) (Object, error) {
	business := s.business()
	if _, e := business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	policy, e := s.policy(ctx, s.Pool)
	if e != nil {
		return nil, e
	}
	if _, e = business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	return merge(Object{"policy": policy}, business.metadata()), nil
}

// ReadPolicyWithCatalog reads the complete current policy and selection catalog
// in one snapshot without making configuration depend on analytics availability.
func (s *Recommendations) ReadPolicyWithCatalog(ctx context.Context, actor Actor) (Object, error) {
	business := s.business()
	if _, e := business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	tx, e := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	policy, e := s.policy(ctx, tx)
	if e != nil {
		return nil, e
	}
	catalog, e := s.catalog(ctx, tx)
	if e != nil {
		return nil, e
	}
	if _, e = business.require(ctx, tx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	if _, e = business.authorize(ctx, actor, "recommendations.read"); e != nil {
		return nil, e
	}
	return merge(Object{"policy": policy, "catalog": Object{"items": catalog}}, business.metadata()), nil
}
