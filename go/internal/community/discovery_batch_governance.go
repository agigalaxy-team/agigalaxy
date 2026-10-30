package community

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// Optional adapter batching preserves an injected governance implementation.
// Older adapters remain supported through their exact single-target method.
type DiscoveryGovernanceBatch interface {
	HiddenBatch(context.Context, pgx.Tx, []Object) ([]bool, error)
}

func targetKey(v Object) string { return string(encode(v)) }
func (s *Service) discoveryGovernanceFacts(ctx context.Context, tx pgx.Tx, targets []Object, f *discoveryFacts) (map[string]bool, error) {
	out := map[string]bool{}
	if len(targets) == 0 {
		return out, nil
	}
	if s.Governance != nil {
		if batch, ok := s.Governance.(DiscoveryGovernanceBatch); ok {
			values, e := batch.HiddenBatch(ctx, tx, targets)
			if e != nil {
				return nil, e
			}
			if len(values) != len(targets) {
				return nil, fail("forum_service_unavailable", 503)
			}
			for i, target := range targets {
				out[targetKey(target)] = values[i]
			}
			return out, nil
		}
		for _, target := range targets {
			v, e := s.Governance.Hidden(ctx, tx, target)
			if e != nil {
				return nil, e
			}
			out[targetKey(target)] = v
		}
		return out, nil
	}
	direct, e := rows(ctx, tx, `SELECT DISTINCT r.target FROM forum_reports_v1 r JOIN forum_operations_events_v1 e ON e.id=r.restriction_event_id JOIN jsonb_array_elements($1::jsonb) t(value) ON t.value=r.target WHERE r.restriction_until>$2 AND e.effect_until>$2`, encode(targets), s.now())
	if e != nil {
		return nil, e
	}
	for _, target := range direct {
		out[targetKey(target)] = true
	}
	reports, e := rows(ctx, tx, `SELECT jsonb_build_object('target',r.target,'report',to_jsonb(r)||jsonb_build_object('subject_id',e.subject_id,'permission_id',e.permission_id,'payload_hash',e.payload_hash,'effect_until',e.effect_until)) FROM forum_reports_v1 r JOIN forum_governance_events_v1 e ON e.id=r.restriction_event_id JOIN jsonb_array_elements($1::jsonb) t(value) ON t.value=r.target WHERE r.restriction_until>$2`, encode(targets), s.now())
	if e != nil {
		return nil, e
	}
	permissionIDs, subjects := []string{}, []string{}
	for _, item := range reports {
		r := obj(item, "report")
		permissionIDs = append(permissionIDs, str(r, "permission_id"))
		subject := str(r, "subject_id")
		if subject != "" {
			subjects = append(subjects, subject)
		}
		for _, key := range []string{"reporter_id", "target_author_id"} {
			if id := str(r, key); id != "" {
				subjects = append(subjects, id)
			}
		}
	}
	permissions, e := s.discoveryPermissionFacts(ctx, tx, batchIDs(permissionIDs...))
	if e != nil {
		return nil, e
	}
	for k, v := range permissions {
		f.permissions[k] = v
	}
	links := map[string]map[string]bool{}
	rows, e := tx.Query(ctx, `SELECT subject_id,account_id::text FROM community_account_links WHERE subject_id=ANY($1::text[])`, subjects)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var subject, account string
		if e = rows.Scan(&subject, &account); e != nil {
			rows.Close()
			return nil, e
		}
		if links[subject] == nil {
			links[subject] = map[string]bool{}
		}
		links[subject][account] = true
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	providers := map[string]map[string]bool{}
	rows, e = tx.Query(ctx, `SELECT g.subject_id,g.account_id::text,l.issuer,l.client_id FROM community_account_links g JOIN external_identity_links l ON l.id=g.identity_link_id WHERE g.subject_id=ANY($1::text[]) AND l.revoked_at IS NULL`, subjects)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var subject, account, issuer, client string
		if e = rows.Scan(&subject, &account, &issuer, &client); e != nil {
			rows.Close()
			return nil, e
		}
		for _, provider := range s.identityProviders() {
			if provider.Issuer == issuer && provider.ClientID == client {
				if providers[subject] == nil {
					providers[subject] = map[string]bool{}
				}
				providers[subject][account] = true
			}
		}
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	for _, item := range reports {
		target, r := obj(item, "target"), obj(item, "report")
		key := targetKey(target)
		if out[key] {
			continue
		}
		subject := str(r, "subject_id")
		allowed, parties := s.independentBase(subject, r)
		if !allowed {
			continue
		}
		shared := false
		for account := range links[subject] {
			for _, party := range parties {
				if links[party][account] {
					shared = true
				}
			}
		}
		if shared {
			continue
		}
		if truth(r, "account_governance") && (providers[subject][str(r, "reporter_account_id")] || providers[subject][str(r, "target_author_account_id")]) {
			continue
		}
		fact := f.permissions[str(r, "permission_id")]
		if fact.permission == nil || !s.decisionPermissionBase(fact.permission, r) || fact.evidence == nil || !decisionConsentValid(fact.permission, fact.evidence, s.Endpoint, s.clock()) || fact.deletion {
			continue
		}
		if r["effect_until"] != nil && seconds(r["effect_until"]) > s.clock() {
			out[key] = true
		}
	}
	return out, nil
}
