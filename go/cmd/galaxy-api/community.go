package main

import (
	"net/http"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/credentials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5/pgxpool"
)

type communityIdentity struct{ gateway *access.Gateway }

func (a communityIdentity) Account(r *http.Request, write bool) (string, community.Authorization, error) {
	id, authority, err := a.gateway.Account(r, write)
	return id, authority, err
}

func loadCommunity(pool *pgxpool.Pool, endpoint string, devices *deviceauth.Service, links *accountlinks.Service, budget *resourcebudget.Service, vcs *credentials.Service, loaded ...func(community.GovernanceRuntime)) (*community.Service, error) {
	policy, err := community.LoadForumPolicy(os.Getenv("GALAXY_FORUM_POLICY_FILE"))
	if err != nil {
		return nil, err
	}
	quotas, err := community.LoadCommunityPolicy(os.Getenv("GALAXY_COMMUNITY_QUOTA_FILE"))
	if err != nil {
		return nil, err
	}
	promotionDays, err := community.CommunityPromotionDays(quotas)
	if err != nil {
		return nil, err
	}
	governance, err := community.LoadGovernanceForRuntime(community.GovernanceOptions{
		ConfigurationPath: os.Getenv("GALAXY_GOVERNANCE_CONFIG"), ReviewPath: os.Getenv("GALAXY_GOVERNANCE_REVIEW_FILE"),
		AuthoritiesPath: os.Getenv("GALAXY_GOVERNANCE_AUTHORITIES_FILE"), Environment: os.Getenv("GALAXY_ENVIRONMENT"), Endpoint: endpoint,
	})
	if err != nil {
		return nil, err
	}
	moderators := []string{}
	configured, ok := governance.Configuration["moderatorIds"].([]any)
	if !ok {
		return nil, fault.New("governance_configuration_invalid", 400)
	}
	for _, raw := range configured {
		id, ok := raw.(string)
		if !ok {
			return nil, fault.New("governance_configuration_invalid", 400)
		}
		moderators = append(moderators, id)
	}
	for _, capture := range loaded {
		if capture != nil {
			capture(governance)
		}
	}
	service := &community.Service{Pool: pool, Endpoint: endpoint, Policy: policy, PromotionDays: promotionDays,
		DeviceAuth: devices, AccountLinks: links, Resources: budget, ModeratorIDs: moderators,
		Conditions: community.CredentialConditions{Service: vcs}}
	if _, err = service.PolicyAdopter(); err != nil {
		return nil, err
	}
	return service, nil
}
