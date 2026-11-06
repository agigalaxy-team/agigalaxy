package communitygrowth

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/honor"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// PublicLegacyHonors reads current public account-to-ID links and asks the
// original Honor service to evaluate each current rule anonymously. It never
// creates a new grant or turns a private ID link into a public one.
func (s *Service) PublicLegacyHonors(ctx context.Context, links *accounts.PublicQueries, h *honor.Service, account string, limit int, after string) (Object, error) {
	if links == nil || links.Service == nil || h == nil || s.Pool == nil || links.Service.Endpoint != s.Endpoint || h.Endpoint != s.Endpoint {
		return nil, fault.New("community_growth_source_unavailable", 503)
	}
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 50 {
		return nil, invalid()
	}
	input := Object{"limit": limit}
	if after != "" {
		input["after"] = after
	}
	raw, _ := json.Marshal(input)
	page, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return links.LinkedIDsWithin(ctx, tx, account, raw) })
	if e != nil {
		if fault.Status(e) == 404 {
			// A readable account with no disclosed ID links has no public
			// legacy honors. Keep a hidden/missing account indistinguishable.
			_, check := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (bool, error) {
				return true, s.publicAccount(ctx, tx, "", account)
			})
			if check == nil {
				return Object{"accountId": account, "items": []Object{}, "nextAfter": nil, "checkedAt": s.now().Unix()}, nil
			}
			return nil, check
		}
		return nil, e
	}
	list, e := h.List(ctx)
	if e != nil {
		return nil, e
	}
	rules, ok := list["rules"].([]any)
	if !ok {
		return nil, fault.New("community_growth_source_unavailable", 503)
	}
	ids, ok := page["items"].([]Object)
	if !ok {
		return nil, fault.New("community_growth_source_unavailable", 503)
	}
	items := []Object{}
	for _, link := range ids {
		subject := str(link, "subjectId")
		for _, rawRule := range rules {
			var rule Object
			switch r := rawRule.(type) {
			case map[string]any:
				rule = r
			case *protocol.OrderedObject:
				if r != nil {
					rule = r.Values()
				}
			}
			if rule == nil || str(rule, "id") == "" || str(rule, "version") == "" {
				return nil, fault.New("community_growth_source_unavailable", 503)
			}
			query := honor.Object{"subjectId": subject, "ruleId": str(rule, "id"), "ruleVersion": str(rule, "version")}
			var result honor.Object
			if str(rule, "sourceProfile") == "facts-v2" || rule["requiredApiVersion"] == 2 {
				result, e = h.QueryV2(ctx, nil, query)
			} else {
				result, e = h.Query(ctx, nil, query)
			}
			if e != nil {
				if fault.Status(e) == 404 {
					continue
				}
				return nil, e
			}
			card, ok := result["card"].(map[string]any)
			if !ok {
				return nil, fault.New("community_growth_source_unavailable", 503)
			}
			if str(card, "status") == "active" {
				items = append(items, Object{"subjectId": subject, "card": card})
			}
		}
	}
	// Honor projections have their own current authorization transactions.
	// Re-read the exact public-link page after those reads so a revoked link or
	// hidden profile cannot leak a previously selected identity in the result.
	current, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) { return links.LinkedIDsWithin(ctx, tx, account, raw) })
	if e != nil {
		return nil, e
	}
	live, ok := current["items"].([]Object)
	if !ok {
		return nil, fault.New("community_growth_source_unavailable", 503)
	}
	visible := map[string]bool{}
	for _, item := range live {
		visible[str(item, "subjectId")] = true
	}
	filtered := []Object{}
	for _, item := range items {
		if visible[str(item, "subjectId")] {
			filtered = append(filtered, item)
		}
	}
	return Object{"accountId": account, "items": filtered, "nextAfter": current["nextAfter"], "checkedAt": current["checkedAt"]}, nil
}
