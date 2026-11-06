package communitygrowth

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ownerReader uses a request-bound account authority. The account and the
// requested target must be identical, and the authority is rechecked in the
// same transaction as the projection read.
func (s *Service) ownerReader(account string, authority AccountAuthority) (*Service, error) {
	if _, e := uuid.Parse(account); e != nil || authority == nil {
		return nil, fault.New("official_account_login_required", 401)
	}
	current := *s
	current.PublicAccountWithin = func(ctx context.Context, tx pgx.Tx, viewer, target string) (Object, error) {
		if viewer != account || target != account {
			return nil, fault.New("official_account_login_required", 401)
		}
		if e := authority.Account(ctx, tx, current.Endpoint, account); e != nil {
			return nil, e
		}
		return Object{"accountId": account}, nil
	}
	return &current, nil
}
func (s *Service) OwnerOverview(ctx context.Context, account string, authority AccountAuthority) (Object, error) {
	current, e := s.ownerReader(account, authority)
	if e != nil {
		return nil, e
	}
	return current.PublicOverview(ctx, account, account)
}
func (s *Service) OwnerContributions(ctx context.Context, account string, authority AccountAuthority, limit int, after string) (Object, error) {
	current, e := s.ownerReader(account, authority)
	if e != nil {
		return nil, e
	}
	return current.PublicContributions(ctx, account, account, limit, after)
}
