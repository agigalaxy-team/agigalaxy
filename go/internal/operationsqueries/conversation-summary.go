package operationsqueries

import (
	"context"
	"sync"

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
	// These readers share only the verified immutable actor, not a transaction
	// or each other's result. Assemble them independently and publish only after
	// all sources and the final current-authority/context barriers have finished.
	var receipts, source, capabilities Object
	var contextErr, sourceErr, capabilitiesErr error
	var readers sync.WaitGroup
	readers.Add(3)
	go func() {
		defer readers.Done()
		receipts, contextErr = s.SummaryContext(ctx, current, domain, bound)
	}()
	go func() {
		defer readers.Done()
		if s.Workbench != nil {
			source, sourceErr = s.WorkbenchSummary(ctx, current)
		}
	}()
	go func() {
		defer readers.Done()
		capabilities, capabilitiesErr = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return s.Permissions.ManagementCapabilitiesWithin(ctx, tx, current) })
	}()
	readers.Wait()
	if contextErr != nil {
		return nil, contextErr
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
		if sourceErr != nil {
			if fault.Status(sourceErr) == 403 {
				return nil, sourceErr
			}
			result = Object{"domain": domain, "availability": "unavailable", "reason": "summary-unavailable"}
		} else {
			result = ConversationSummary(source, domain, current.Permissions)
		}
	}
	if capabilitiesErr != nil {
		return nil, capabilitiesErr
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
	result["queryAccess"], result["managementCapabilities"] = operationsai.QueryAccess(fresh.Permissions), capabilities
	for _, key := range []string{"priorReadReceipts", "currentReadOutcomes", "turnOutcomes", "priorActionReceipts", "priorOperationReceipts", "boundedTask"} {
		result[key] = receipts[key]
	}
	return result, nil
}
