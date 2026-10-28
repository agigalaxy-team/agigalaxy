package main

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/incident"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimeconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/servicemetadata"
	"os"
)

func loadedJSONHash(value any) (string, error) {
	raw, e := protocol.EncodeJS(value)
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}

// recordAPIConfiguration runs before any registry-backed domain initializes.
// Every input comes from the same loader result used by this API instance.
func recordAPIConfiguration(ctx context.Context, gateway *access.Gateway, devices *deviceauth.Service, metadata *servicemetadata.Service, governance community.GovernanceRuntime, forumPolicy community.Object, chatService *chat.Service, incidentState *incident.Controller, lifecycle *retirement.Controller, budgetPolicy *resourcebudget.Policy, identityHash string, chatHash *string, quotaHash, browserHash string, personalHash *string, release *runtimeconfig.ServiceRelease) error {
	forumHash, e := community.ForumPolicyHash(forumPolicy)
	if e != nil {
		return e
	}
	communityHash, e := community.CommunityPolicyHash(chatService.CommunityPolicy)
	if e != nil {
		return e
	}
	resourceHash, e := loadedJSONHash(budgetPolicy)
	if e != nil {
		return e
	}
	accountHash := gateway.Config.AccountScope
	sources := runtimeconfig.LoadedSources{Governance: governance.Configuration, GovernanceReview: governance.Review, Incident: incidentState.Policy(), Retirement: lifecycle.Snapshot().Policy, Hashes: runtimeconfig.LoadedHashes{RequestQuota: &quotaHash, BrowserPolicy: &browserHash, ResourceBudget: &resourceHash, CommunityQuota: &communityHash, ForumPolicy: &forumHash, IdentityConfiguration: &identityHash, ChatConfiguration: &runtimeconfig.NullableHash{Value: chatHash}, PersonalMCPConfiguration: &runtimeconfig.NullableHash{Value: personalHash}, OfficialAccountConfiguration: &runtimeconfig.NullableHash{Value: &accountHash}}}
	sources.ObserveRelease(release)
	if devices != nil {
		if keys, ok := devices.Signer.(*deviceauth.SessionKeyring); ok {
			kid, sequence := keys.KID, keys.TrustSequence()
			sources.SigningKeyID, sources.TrustSequence = &kid, &sequence
		}
	}
	if metadata != nil {
		sources.Network, e = metadata.ManifestObservation()
		if e != nil {
			return e
		}
	}
	_, e = runtimeconfig.RecordLoaded(ctx, gateway.Pool, gateway.Config.Endpoint, "api", os.Getenv("GALAXY_OPERATOR_REF"), sources, runtimeconfig.Options{})
	return e
}
