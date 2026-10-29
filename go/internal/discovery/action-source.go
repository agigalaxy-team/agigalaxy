package discovery

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"slices"
)

// QualifyPreparedDraftWithin validates the reviewed head and the grant's
// concrete creation/update scope in the owning duty transaction.
func (q *SearchQuality) QualifyPreparedDraftWithin(ctx context.Context, tx pgx.Tx, actor Actor, command Object, target, grantID string) error {
	state, e := q.state(ctx, tx)
	if e != nil {
		return e
	}
	if number(state, "revision") != number(command, "expectedRevision") || state["pending_operation"] != nil || state["draft_id"] != command["expectedDraftId"] {
		return qualityFailure("search_quality_draft_changed")
	}
	if _, e = canonicalSettings(object(command["settings"])); e != nil {
		return e
	}
	if grantID == "" {
		return qualityFailure("operations_agentos_human_review_required")
	}
	var kind string
	var ids []string
	if e = tx.QueryRow(ctx, `SELECT resource_scope_kind,resource_ids::text[] FROM operations_automation_grants_v1 WHERE endpoint=$1 AND id=$2`, q.Endpoint, grantID).Scan(&kind, &ids); e != nil {
		return e
	}
	if state["draft_id"] == nil {
		if kind != "eligible" {
			return qualityFailure("operations_agentos_human_review_required")
		}
		return nil
	}
	if state["draft_id"] != target {
		return qualityFailure("operations_agentos_scope_denied", 403)
	}
	if kind != "eligible" && (kind != "selected" || !slices.Contains(ids, target)) {
		return qualityFailure("operations_agentos_scope_denied", 403)
	}
	draft, e := q.version(ctx, tx, target)
	if e != nil {
		return e
	}
	if draft == nil || draft["operator_id"] != actor.ID {
		return qualityFailure("operations_agentos_human_review_required")
	}
	var count int
	e = tx.QueryRow(ctx, `SELECT count(*) FROM operations_search_quality_operations_v1 o JOIN business_admin_audit_v1 a ON a.endpoint=o.endpoint AND a.operation_id=o.operation_id WHERE o.endpoint=$1 AND o.version_id=$2 AND o.kind='draft' AND a.actor_kind='operations-ai-service' AND a.operator_id=$3 AND a.grant_id=$4`, q.Endpoint, target, actor.ID, grantID).Scan(&count)
	if e != nil {
		return e
	}
	if count != 1 {
		return qualityFailure("operations_agentos_human_review_required")
	}
	return nil
}

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
	return rowObject(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT operator_id,kind,version_id,input,request_hash FROM operations_search_quality_operations_v1 WHERE endpoint=$1 AND operation_id=$2)r`, q.Endpoint, id)
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

// CommandVersionWithin is an internal, non-mutating original-command check.
// Its caller already owns current authorization; raw configuration is not a public receipt.
func (q *SearchQuality) CommandVersionWithin(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
	if !validID(id) {
		return nil, settingsInvalid()
	}
	return q.version(ctx, tx, id)
}
