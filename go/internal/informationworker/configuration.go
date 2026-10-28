package informationworker

import (
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimeconfig"
)

type ProcessConfiguration struct {
	SourceDatabaseURL, TransportDatabaseURL string
	Sources                                 SourceConfiguration
}

// Load reads process configuration references; it never opens an account or
// management session, a provider secret environment value, or an issuer key.
func Load(getenv func(string) string) (ProcessConfiguration, error) {
	if getenv == nil {
		getenv = os.Getenv
	}
	if _, e := runtimeconfig.RuntimeServiceRelease(getenv, "information-worker", ""); e != nil {
		return ProcessConfiguration{}, e
	}
	c := ProcessConfiguration{SourceDatabaseURL: getenv("GALAXY_INFORMATION_SOURCE_DATABASE_URL"), TransportDatabaseURL: getenv("GALAXY_INFORMATION_TRANSPORT_DATABASE_URL")}
	c.Sources = SourceConfiguration{
		Endpoint: getenv("GALAXY_ENDPOINT"), RootPinsFile: getenv("GALAXY_ROOT_PINS_FILE"), KeyringFile: getenv("GALAXY_KEYRING_FILE"), TrustDirectory: getenv("GALAXY_TRUST_DIRECTORY"),
		RetirementFile: getenv("GALAXY_RETIREMENT_FILE"), IncidentFile: getenv("GALAXY_INCIDENT_FILE"), BudgetFile: getenv("GALAXY_RESOURCE_BUDGET_FILE"),
		ForumPolicyFile: getenv("GALAXY_FORUM_POLICY_FILE"), CommunityPolicyFile: getenv("GALAXY_COMMUNITY_QUOTA_FILE"),
		GovernanceFile: getenv("GALAXY_GOVERNANCE_CONFIG"), GovernanceReviewFile: getenv("GALAXY_GOVERNANCE_REVIEW_FILE"), GovernanceAuthoritiesFile: getenv("GALAXY_GOVERNANCE_AUTHORITIES_FILE"), Environment: getenv("GALAXY_ENVIRONMENT"),
		ExternalCredentialsFile: getenv("GALAXY_EXTERNAL_CREDENTIALS_CONFIG_FILE"), AttachmentsFile: getenv("GALAXY_ATTACHMENTS_CONFIG_FILE"), CredentialsDirectory: getenv("CREDENTIALS_DIRECTORY"), ChatFile: getenv("GALAXY_CHAT_CONFIG_FILE"),
	}
	if c.SourceDatabaseURL == "" || c.TransportDatabaseURL == "" || c.Sources.Endpoint == "" || c.Sources.RootPinsFile == "" || c.Sources.KeyringFile == "" || c.Sources.TrustDirectory == "" {
		return c, fault.New("information_worker_configuration_unavailable", 503)
	}
	providers, e := access.LoadIdentityProviders(getenv("GALAXY_IDENTITY_CONFIG_FILE"))
	if e != nil {
		return c, e
	}
	for _, p := range providers {
		c.Sources.Providers = append(c.Sources.Providers, accountlinks.Provider{Issuer: p.Issuer, ClientID: p.ClientID})
	}
	return c, nil
}
