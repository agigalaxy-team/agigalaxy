package operationsqueries

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

// Summary receives context bound by ConversationTools, never public options.
// All conversation receipts retain their original current owner and fixed AI.
func (s *Service) Summary(ctx context.Context, a Actor, domain string, bound Object) (Object, error) {
	if !exact(bound, "conversationId", "turnId") || len(bound) != 2 || !validID(bound["conversationId"]) || !validID(bound["turnId"]) {
		return nil, invalid()
	}
	current, e := s.human(ctx, a, domain, "workbench.read")
	if e != nil {
		return nil, e
	}
	if s.SummaryContext == nil || s.RecheckContext == nil {
		return nil, fail("operations_agentos_conversation_not_ready", 503)
	}
	receipts, e := s.SummaryContext(ctx, current, domain, bound)
	if e != nil {
		return nil, e
	}
	for _, key := range []string{"priorReadReceipts", "priorActionReceipts", "priorOperationReceipts", "boundedTask"} {
		if _, ok := receipts[key]; !ok {
			return nil, fail("operations_agentos_conversation_not_ready", 503)
		}
	}
	var result Object
	if s.Workbench == nil {
		result = Object{"domain": domain, "availability": "unavailable", "reason": "summary-not-connected"}
	} else {
		source, err := s.WorkbenchSummary(ctx, current)
		if err != nil {
			if fault.Status(err) == 403 {
				return nil, err
			}
			result = Object{"domain": domain, "availability": "unavailable", "reason": "summary-unavailable"}
		} else {
			result = ConversationSummary(source, domain, current.Permissions)
		}
	}
	fresh, e := s.human(ctx, current, domain, "workbench.read")
	if e != nil {
		return nil, e
	}
	if fresh.Version != current.Version {
		return nil, fail("operations_agentos_authority_changed", 403)
	}
	if e = s.RecheckContext(ctx, fresh, domain, bound); e != nil {
		return nil, e
	}
	capabilities, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.Permissions.ManagementCapabilitiesWithin(ctx, tx, fresh) })
	if e != nil {
		return nil, e
	}
	if _, e = s.human(ctx, fresh, domain, "workbench.read"); e != nil {
		return nil, e
	}
	result["queryAccess"], result["managementCapabilities"] = operationsai.QueryAccess(fresh.Permissions), capabilities
	for _, key := range []string{"priorReadReceipts", "priorActionReceipts", "priorOperationReceipts", "boundedTask"} {
		result[key] = receipts[key]
	}
	return result, nil
}
