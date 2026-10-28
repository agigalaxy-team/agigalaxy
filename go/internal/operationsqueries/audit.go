package operationsqueries

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsaudit"
)

func auditItem(row Object) Object {
	if _, e := time.Parse(time.RFC3339Nano, str(row["createdAt"])); e != nil {
		return nil
	}
	safe := operationsaudit.Metadata(Object{"id": row["id"], "sequence": row["sequence"], "action": row["action"], "operator_id": row["operatorId"], "operator_display_name": row["operatorDisplayName"], "operator_role": row["operatorRole"], "actor_kind": row["actorKind"], "execution_id": row["executionId"], "grant_id": row["grantId"], "account_id": row["accountId"], "operation_id": row["operationId"], "http_request_id": nil, "selection": row["selection"], "result": row["result"], "audit_attribution": row["attribution"], "created_at": row["createdAt"]})
	attribution := merge(object(safe["attribution"]), Object{"initiatorOperatorId": nil})
	return merge(object(project(safe, shape("id sequence action actorKind operatorDisplayName accountId operationId createdAt", "s"))), Object{"attribution": attribution, "selection": safe["selection"], "result": safe["result"]})
}
func (s *Service) audit(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Audit == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	source, e := s.Audit.AuditWithAuthority(ctx, a, args.filters, s.reader(a))
	if e != nil {
		return queryResult{}, e
	}
	all, ok := source["items"].([]any)
	if !ok {
		return queryResult{}, fail("operations_query_response_invalid", 503)
	}
	items := []any{}
	for _, value := range all {
		if row := auditItem(object(value)); row != nil {
			items = append(items, row)
		}
	}
	next := source["nextAfter"]
	var resume any
	if next != nil && next != "" {
		resume = Object{"module": "audit", "view": "list", "filters": merge(args.filters, Object{"after": next})}
	}
	complete := resume == nil && source["scanTruncated"] != true && source["scanLimited"] != true
	return queryResult{source: source, data: Object{"items": items, "coverage": "returned-page", "scanLimited": source["scanTruncated"] == true || source["scanLimited"] == true}, pagination: Object{"next": resume, "complete": complete}}, nil
}
