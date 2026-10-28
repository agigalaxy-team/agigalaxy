package runtimeconfig

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
	"github.com/jackc/pgx/v5/pgxpool"
)

// NullableHash distinguishes an explicitly absent optional loaded service
// (null) from a field which this process never loaded (omitted).
type NullableHash struct{ Value *string }
type LoadedHashes struct {
	RequestQuota, ResourceBudget, IdentityConfiguration, CommunityQuota, ForumPolicy, BrowserPolicy *string
	ChatConfiguration, PersonalMCPConfiguration, OfficialAccountConfiguration                       *NullableHash
}

// LoadedSources contains the values already used to construct this process.
// Callers retain the original configuration hashes, not secrets or env dumps.
type LoadedSources struct {
	Governance, GovernanceReview Object
	Incident                     *incident.Policy
	Retirement                   *retirement.Policy
	Release                      Object
	SigningKeyID                 *string
	TrustSequence                *int64
	Hashes                       LoadedHashes
	SearchIndexMode              *string
	Network                      Object
}

func (s LoadedSources) input() Object {
	in := Object{"incident": nil}
	if s.Governance != nil {
		in["governance"] = s.Governance
		in["governanceReview"] = s.GovernanceReview
	}
	if s.Incident != nil {
		in["incident"] = s.Incident
	}
	if s.Retirement != nil {
		in["retirement"] = s.Retirement
	}
	if s.Release != nil {
		in["release"] = s.Release
	}
	if s.SigningKeyID != nil {
		in["signingKeyId"] = *s.SigningKeyID
	}
	if s.TrustSequence != nil {
		in["trustSequence"] = *s.TrustSequence
	}
	for key, value := range map[string]*string{"requestQuotaHash": s.Hashes.RequestQuota, "resourceBudgetHash": s.Hashes.ResourceBudget, "identityConfigurationHash": s.Hashes.IdentityConfiguration, "communityQuotaHash": s.Hashes.CommunityQuota, "forumPolicyHash": s.Hashes.ForumPolicy, "browserPolicyHash": s.Hashes.BrowserPolicy} {
		if value != nil {
			in[key] = *value
		}
	}
	for key, value := range map[string]*NullableHash{"chatConfigurationHash": s.Hashes.ChatConfiguration, "personalMcpConfigurationHash": s.Hashes.PersonalMCPConfiguration, "officialAccountConfigurationHash": s.Hashes.OfficialAccountConfiguration} {
		if value != nil {
			in[key] = value.Value
		}
	}
	if s.SearchIndexMode != nil {
		in["searchIndexMode"] = *s.SearchIndexMode
	}
	if s.Network != nil {
		in["network"] = s.Network
	}
	return in
}

// LoadedCommand preserves the original startup source mapping. API registry
// observations always accompany their actual loaded definitions; no empty
// fallback is manufactured for an unported or unavailable source.
func LoadedCommand(endpoint, component, operatorRef string, s LoadedSources) (Object, error) {
	if component != "api" && component != "worker" {
		return nil, invalid()
	}
	input := s.input()
	out := Object{"endpoint": endpoint, "component": component}
	if operatorRef != "" {
		out["operatorRef"] = operatorRef
	}
	if component == "api" {
		if s.Governance == nil {
			return nil, mismatch("API runtime observation requires loaded governance")
		}
		governance, e := community.ParseGovernance(s.Governance)
		if e != nil {
			return nil, e
		}
		input["governance"] = governance
		out["honorRules"], out["qualificationPolicies"], out["experienceReviewers"] = governance["honorRules"], governance["qualificationPolicies"], governance["experienceReviewers"]
		if out["experienceReviewers"] == nil {
			out["experienceReviewers"] = []any{}
		}
	}
	snapshot, e := Build(input)
	if e != nil {
		return nil, e
	}
	out["snapshot"] = snapshot
	return out, nil
}
func RecordLoaded(ctx context.Context, pool *pgxpool.Pool, endpoint, component, operatorRef string, s LoadedSources, options Options) (Event, error) {
	input, e := LoadedCommand(endpoint, component, operatorRef, s)
	if e != nil {
		return Event{}, e
	}
	return Record(ctx, pool, input, options)
}
