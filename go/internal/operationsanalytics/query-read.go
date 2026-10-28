package operationsanalytics

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// QueryRead is an internal facade for the currently authenticated typed query
// reader. It retains the same sources and checks without changing HTTP authority.
func (s *Service) QueryRead(ctx context.Context, a Actor, authority p.Authority, view, id string, filters Object) (Object, error) {
	if s == nil || s.Domain == nil || authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	domain := *s.Domain
	guard := &p.BusinessAuthority{Human: authority}
	if live, ok := domain.Authority.(*p.BusinessAuthority); ok {
		guard.Duty, guard.Execution = live.Duty, live.Execution
	}
	domain.Authority = guard
	reader := *s
	reader.Domain = &domain
	if r := s.Runtime; r != nil {
		runtimeGuard := &p.BusinessAuthority{Human: authority}
		if r.Authority != nil {
			runtimeGuard.Duty, runtimeGuard.Execution = r.Authority.Duty, r.Authority.Execution
		}
		reader.Runtime = &discovery.Runtime{Store: r.Store, Source: r.Source, Meili: r.Meili, Gorse: r.Gorse, Now: r.Now, SearchQuality: r.SearchQuality, Recommendations: r.Recommendations, OpenPanel: r.OpenPanel, Authority: runtimeGuard}
	}
	switch view {
	case "directory-summary":
		return reader.DirectorySummary(ctx, a, filters)
	case "account-summary":
		return reader.AccountSummary(ctx, a, id, filters)
	case "usage":
		return reader.Usage(ctx, a, id, filters)
	case "profile":
		return reader.Profile(ctx, a, id, filters)
	default:
		return nil, fail("invalid_business_admin_request", 400)
	}
}
