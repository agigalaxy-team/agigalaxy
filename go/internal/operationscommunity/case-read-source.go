package operationscommunity

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

// CaseReadSourceQueryWithin retains the validated fixed-AI query proof.
func (s *Service) CaseReadSourceQueryWithin(ctx context.Context, tx pgx.Tx, actor Actor, authority operationspermissions.Authority, id string) (Object, error) {
	if s == nil || !operationspermissions.OriginalAIReceiptQueryReaderMatches(authority, actor) {
		return nil, fail("business_admin_denied", 403)
	}
	clone := *s
	clone.Authority, clone.Duty = authority, nil
	return clone.CaseReadSourceWithin(ctx, tx, actor, id)
}

// CaseReadSourceWithin establishes only metadata availability, never authority
// to read report materials or resolve the case.
func (s *Service) CaseReadSourceWithin(ctx context.Context, tx pgx.Tx, actor Actor, id string) (Object, error) {
	if s == nil || s.Authority == nil {
		return nil, fail("operations_authorization_unavailable", 503)
	}
	authority := &operationspermissions.BusinessAuthority{Human: s.Authority, Duty: s.Duty}
	current, e := authority.RequireWithin(ctx, tx, actor, "cases.read")
	if e != nil {
		return nil, e
	}
	if e = s.domain().Principal(ctx, tx, current); e != nil {
		return nil, e
	}
	row, e := s.reportWithin(ctx, tx, id, false)
	if e != nil {
		return nil, e
	}
	if _, e = s.independent(ctx, tx, row, current); e != nil {
		return nil, e
	}
	if num(row, "version") < 1 {
		return nil, fail("operations_source_unavailable", 503)
	}
	current, e = authority.RequireWithin(ctx, tx, current, "cases.read")
	if e != nil {
		return nil, e
	}
	if e = s.domain().Principal(ctx, tx, current); e != nil {
		return nil, e
	}
	return Object{"id": id, "available": true, "version": row["version"]}, nil
}
