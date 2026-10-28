package discovery

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

func ParseRecommendationPolicy(input Object) (Object, error) {
	return parseRecommendationCommand("policy", input)
}
func ParseSearchCommand(kind string, input Object) (Object, error) {
	return parseQualityInput(kind, input)
}
func (q *SearchQuality) VersionWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	return q.version(ctx, tx, id)
}
func (s *Recommendations) CommandRecordWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	return rowObject(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT operator_id,kind,revision,theme_key,request_hash,result FROM operations_recommendation_events_v1 WHERE endpoint=$1 AND operation_id=$2)r`, s.Endpoint, id)
}
func (q *SearchQuality) CommandRecordWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	return rowObject(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT operator_id,kind,version_id FROM operations_search_quality_operations_v1 WHERE endpoint=$1 AND operation_id=$2)r`, q.Endpoint, id)
}

// WithAuthority shares the original reconciliation coordinator while preserving
// this request's real purpose-limited authority and native clients.
func (q *SearchQuality) WithAuthority(authority *operationspermissions.BusinessAuthority) *SearchQuality {
	if q == nil {
		return nil
	}
	owner := q
	if q.reconcileOwner != nil {
		owner = q.reconcileOwner
	}
	return &SearchQuality{Pool: q.Pool, Endpoint: q.Endpoint, Authority: authority, Meili: q.Meili, OpenPanel: q.OpenPanel, Now: q.Now, reconcileOwner: owner}
}
func (q *SearchQuality) WithAuthorize(authority *operationspermissions.BusinessAuthority, fresh func(context.Context, pgx.Tx) (Actor, error)) *SearchQuality {
	copy := q.WithAuthority(authority)
	if copy != nil {
		copy.preparedAuthorize = fresh
	}
	return copy
}
func (s *Recommendations) WithAuthorize(authority *operationspermissions.BusinessAuthority, fresh func(context.Context, pgx.Tx) (Actor, error)) *Recommendations {
	if s == nil {
		return nil
	}
	return &Recommendations{Pool: s.Pool, Endpoint: s.Endpoint, Authority: authority, Source: s.Source, OpenPanel: s.OpenPanel, Now: s.Now, preparedAuthorize: fresh}
}
