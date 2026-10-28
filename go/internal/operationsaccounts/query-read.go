package operationsaccounts

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// QueryRead retains the same live account and analytics consumers through the
// caller's trusted purpose-limited authority. It never changes the actor proof.
func (s *Service) QueryRead(ctx context.Context, a Actor, authority operationspermissions.Authority, view, id string, filters Object) (Object, error) {
	if s == nil || s.Domain == nil || authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	d := *s.Domain
	d.Authority = authority
	d.Duty = nil
	reader := &Service{Domain: &d, Accounts: s.Accounts, LookupIdentity: s.LookupIdentity, FindByEmail: s.FindByEmail, DirectorySummary: s.DirectorySummary, AccountSummary: s.AccountSummary, AnalysisQueryRead: s.AnalysisQueryRead}
	switch view {
	case "list":
		return reader.List(ctx, a, filters)
	case "get":
		if len(filters) != 0 {
			return nil, invalid()
		}
		return reader.Get(ctx, a, id)
	case "directorySummary", "accountSummary":
		if s.AnalysisQueryRead == nil {
			return nil, fail("operations_query_not_configured", 503)
		}
		sourceView := "directory-summary"
		if view == "accountSummary" {
			sourceView = "account-summary"
		}
		return s.AnalysisQueryRead(ctx, a, authority, sourceView, id, filters)
	default:
		return nil, invalid()
	}
}
