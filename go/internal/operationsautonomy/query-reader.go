package operationsautonomy

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	permissions "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
)

// WorkbenchSummaryWithAuthority preserves the query's current human × fixed-AI
// authority. It creates a read facade without copying mutexes or worker state.
func (s *Service) WorkbenchSummaryWithAuthority(ctx context.Context, a Actor, authority permissions.Authority) (Object, error) {
	accept, ok := authority.(interface{ AcceptsQuery(Actor) bool })
	if !ok || !accept.AcceptsQuery(a) {
		return nil, fault.New("business_admin_denied", 403)
	}
	reader := &Service{Pool: s.Pool, Endpoint: s.Endpoint, Authority: authority, AIWork: s.AIWork, Now: s.Now, QualifyTargetWithin: s.QualifyTargetWithin, CurrentPublicSourceWithin: s.CurrentPublicSourceWithin, RuntimeStatus: s.RuntimeStatus, ReadTargetWithin: s.ReadTargetWithin, Native: s.Native, Permissions: s.Permissions, WorkbenchRunDetail: s.WorkbenchRunDetail}
	s.defaultsMu.RLock()
	if s.defaults != nil {
		reader.defaults = Object{}
		for k, v := range s.defaults {
			reader.defaults[k] = v
		}
	}
	s.defaultsMu.RUnlock()
	return reader.WorkbenchSummary(ctx, a)
}
