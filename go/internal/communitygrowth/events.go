package communitygrowth

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/jackc/pgx/v5"
	"strings"
)

// PublicEventRead checks the same explicitly public profile eligibility as
// public growth reads, without loading or transmitting growth data.
func (s *Service) PublicEventRead(ctx context.Context, p webevents.Principal, id, parent string) (map[string]any, error) {
	if s == nil || s.Pool == nil || p.Endpoint != s.Endpoint || p.Surface != "web" {
		return nil, fault.New("web_events_authority_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (map[string]any, error) {
		if e := s.publicAccount(ctx, tx, "", id); e != nil {
			return nil, e
		}
		if parent != "" {
			kind, sourceID, ok := strings.Cut(parent, ":")
			if !ok || (kind != "post" && kind != "reply") || sourceID == "" {
				return nil, fault.New("web_events_access_denied", 403)
			}
			view, e := s.ReadEligibleWithin(ctx, tx, kind, sourceID)
			if e != nil {
				return nil, e
			}
			if view == nil {
				return map[string]any{"eligible": false}, nil
			}
		}
		return map[string]any{"accountId": id, "eligible": true}, nil
	})
}
