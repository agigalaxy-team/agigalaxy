package access

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/portal"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5/pgxpool"
)

func protectedJSON(file string, max int64, target any) error {
	if !filepath.IsAbs(file) {
		return fault.New("server_configuration_invalid", 400)
	}
	before, e := os.Lstat(file)
	if e != nil || !before.Mode().IsRegular() || before.Size() > max || runtime.GOOS != "windows" && before.Mode().Perm()&0007 != 0 {
		return fault.New("server_configuration_unavailable", 503)
	}
	f, e := os.Open(file)
	if e != nil {
		return fault.New("server_configuration_unavailable", 503)
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !os.SameFile(before, opened) {
		return fault.New("server_configuration_unavailable", 503)
	}
	b, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil || int64(len(b)) > max {
		return fault.New("server_configuration_invalid", 400)
	}
	after, e := f.Stat()
	if e != nil || after.Size() != int64(len(b)) || !after.ModTime().Equal(opened.ModTime()) {
		return fault.New("server_configuration_unavailable", 503)
	}
	if protocol.Decode(b, target) != nil {
		return fault.New("server_configuration_invalid", 400)
	}
	return nil
}

type renewalConfiguration struct {
	KeyFile string `json:"keyFile"`
	Idle    *int64 `json:"idleSeconds,omitempty"`
	Maximum *int64 `json:"maximumSeconds,omitempty"`
	Before  *int64 `json:"refreshBeforeSeconds,omitempty"`
}

func (c *renewalConfiguration) policy() (portal.Policy, error) {
	idle, maximum, before := int64(604800), int64(2592000), int64(60)
	if c.Idle != nil {
		idle = *c.Idle
	}
	if c.Maximum != nil {
		maximum = *c.Maximum
	}
	if c.Before != nil {
		before = *c.Before
	}
	return portal.LoadPolicy(c.KeyFile, idle, maximum, before)
}

type accountConfiguration struct {
	Version       int                   `json:"version"`
	ClientID      string                `json:"clientId"`
	Issuer        string                `json:"issuer"`
	WebsiteOrigin string                `json:"websiteOrigin"`
	Renewal       *renewalConfiguration `json:"sessionRenewal,omitempty"`
}
type directoryReference struct {
	Issuer               string `json:"issuer"`
	CredentialFile       string `json:"credentialFile"`
	WriterCredentialFile string `json:"writerCredentialFile,omitempty"`
}
type operationsConfiguration struct {
	Version          int                   `json:"version"`
	AdminOrigin      string                `json:"adminOrigin"`
	Issuer           string                `json:"issuer"`
	ClientID         string                `json:"clientId"`
	CredentialFile   string                `json:"directoryCredentialFile"`
	Roles            json.RawMessage       `json:"roles"`
	DirectoryOrigin  string                `json:"directoryOrigin,omitempty"`
	AccountDirectory directoryReference    `json:"accountDirectory"`
	RootFile         string                `json:"rootOperatorFile"`
	Management       json.RawMessage       `json:"managementAccounts,omitempty"`
	Renewal          *renewalConfiguration `json:"sessionRenewal,omitempty"`
}
type rootConfiguration struct {
	Version    int    `json:"version"`
	Endpoint   string `json:"endpoint"`
	Issuer     string `json:"issuer"`
	Subject    string `json:"externalSubject"`
	OperatorID string `json:"operatorId"`
}
type identityConfiguration struct {
	Version   int `json:"version"`
	Providers []struct {
		ID                string   `json:"id"`
		Name              string   `json:"name"`
		Issuer            string   `json:"issuer"`
		ClientID          string   `json:"clientId"`
		SecretEnvironment string   `json:"clientSecretEnv,omitempty"`
		Origins           []string `json:"allowedOrigins,omitempty"`
	} `json:"providers"`
}

// Load reuses the original protected configuration files. It neither copies
// credentials to a new configuration nor reads host model/provider secrets.
// Login issuance and non-feedback domains remain on their existing runtime
// until their own Go migration is complete; this loader is not a cutover.
func Load(ctx context.Context, pool *pgxpool.Pool, endpoint, accountFile, operationsFile, identityFile string, observed ...func(string)) (*Gateway, error) {
	var account accountConfiguration
	var operations operationsConfiguration
	var providers identityConfiguration
	var root rootConfiguration
	if e := protectedJSON(accountFile, 4096, &account); e != nil {
		return nil, e
	}
	if e := protectedJSON(operationsFile, 16384, &operations); e != nil {
		return nil, e
	}
	if e := protectedJSON(identityFile, 32768, &providers); e != nil {
		return nil, e
	}
	if e := protectedJSON(operations.RootFile, 16384, &root); e != nil {
		return nil, e
	}
	if account.Version != 1 || operations.Version != 1 || providers.Version != 1 || root.Version != 1 || root.Endpoint != endpoint || root.Issuer != operations.Issuer || operations.AccountDirectory.Issuer != account.Issuer || account.Issuer == operations.Issuer {
		return nil, fault.New("server_configuration_invalid", 400)
	}
	var roles struct {
		Administrator string `json:"administrator"`
		Reader        string `json:"reader"`
	}
	if protocol.Decode(operations.Roles, &roles) != nil {
		return nil, fault.New("server_configuration_invalid", 400)
	}
	clients := []string{}
	identityProviders := []accounts.Provider{}
	for _, p := range providers.Providers {
		identityProviders = append(identityProviders, accounts.Provider{Issuer: p.Issuer, ClientID: p.ClientID})
		if p.Issuer == account.Issuer {
			clients = append(clients, p.ClientID)
		}
	}
	sort.Strings(clients)
	if len(clients) == 0 {
		return nil, fault.New("server_configuration_invalid", 400)
	}
	// Ordered fields preserve the existing JSON.stringify scope bytes. The raw
	// roles object also retains its original key order; it is not recanonicalized.
	b, e := protocol.Encode(struct {
		Endpoint string   `json:"endpoint"`
		Website  string   `json:"websiteOrigin"`
		Issuer   string   `json:"issuer"`
		Client   string   `json:"clientId"`
		Clients  []string `json:"associationClients"`
	}{endpoint, account.WebsiteOrigin, account.Issuer, account.ClientID, clients})
	if e != nil {
		return nil, e
	}
	accountScope := identity.Digest(b)
	rootValue := struct {
		ID      string `json:"operatorId"`
		Issuer  string `json:"issuer"`
		Subject string `json:"externalSubject"`
	}{root.OperatorID, root.Issuer, root.Subject}
	b, e = protocol.Encode(struct {
		Endpoint  string          `json:"endpoint"`
		Admin     string          `json:"adminOrigin"`
		Issuer    string          `json:"issuer"`
		Client    string          `json:"clientId"`
		Roles     json.RawMessage `json:"roles"`
		Authority string          `json:"authority"`
		Root      any             `json:"root"`
	}{endpoint, operations.AdminOrigin, operations.Issuer, operations.ClientID, operations.Roles, "preconfigured-root-v1", rootValue})
	if e != nil {
		return nil, e
	}
	operatorScope := identity.Digest(b)
	var credential struct {
		Version  int    `json:"version"`
		ClientID string `json:"clientId"`
		Secret   string `json:"clientSecret"`
	}
	if e = protectedJSON(operations.CredentialFile, 16384, &credential); e != nil {
		return nil, e
	}
	if credential.Version != 1 {
		return nil, fault.New("server_configuration_invalid", 400)
	}
	directory, e := NewKeycloakDirectory(KeycloakConfig{Issuer: operations.Issuer, AdminOrigin: operations.DirectoryOrigin, ClientID: credential.ClientID, ClientSecret: credential.Secret})
	if e != nil {
		return nil, e
	}
	g, e := New(pool, Config{Endpoint: endpoint, WebsiteOrigin: account.WebsiteOrigin, AdminOrigin: operations.AdminOrigin, AccountIssuer: account.Issuer, OperatorIssuer: operations.Issuer, AccountScope: accountScope, OperatorConfiguration: operatorScope,
		AccountClientID: account.ClientID, AssociationClients: clients, IdentityProviders: identityProviders, AdministratorRole: roles.Administrator, ReaderRole: roles.Reader, Root: &Root{root.OperatorID, root.Issuer, root.Subject}}, directory)
	if e != nil {
		return nil, e
	}
	if account.Renewal != nil {
		policy, e := account.Renewal.policy()
		if e != nil {
			return nil, e
		}
		provider, e := portal.NewOIDCLoader(portal.OIDCConfig{Issuer: account.Issuer, ClientID: account.ClientID})
		if e != nil {
			return nil, e
		}
		g.AccountRenewal, e = portal.New(pool, "account", []string{accountScope}, policy, provider)
		if e != nil {
			return nil, e
		}
	}
	if operations.Renewal != nil {
		policy, e := operations.Renewal.policy()
		if e != nil {
			return nil, e
		}
		provider, e := portal.NewOIDCLoader(portal.OIDCConfig{Issuer: operations.Issuer, ClientID: operations.ClientID})
		if e != nil {
			return nil, e
		}
		g.OperatorRenewal, e = portal.New(pool, "operator", []string{endpoint, operatorScope}, policy, provider)
		if e != nil {
			return nil, e
		}
	}
	// Discovery is lazy for login. A provider outage must not prevent unrelated
	// reads or an existing valid portal session from starting the API.
	namespaceBytes, e := protocol.Encode(struct {
		Endpoint string `json:"endpoint"`
		Origin   string `json:"origin"`
		Issuer   string `json:"issuer"`
		ClientID string `json:"clientId"`
	}{endpoint, operations.AdminOrigin, operations.Issuer, operations.ClientID})
	if e != nil {
		return nil, e
	}
	g.operatorLoginFactory = func(ctx context.Context) (*portal.Login, error) {
		provider, e := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: operations.Issuer, ClientID: operations.ClientID})
		if e != nil {
			return nil, e
		}
		return portal.NewLogin(pool, provider, portal.LoginOptions{ID: "operations-admin", Name: "银河运营管理", RedirectURI: operations.AdminOrigin + "/v1/operations/callback", Namespace: "operations:" + identity.Digest(namespaceBytes), IncludeProfile: true, IncludeRoles: true, FreshLogin: true, Renewal: operations.Renewal != nil})
	}
	g.accountLoginFactory = func(ctx context.Context) (*portal.Login, error) {
		provider, e := portal.NewOIDC(ctx, portal.OIDCConfig{Issuer: account.Issuer, ClientID: account.ClientID})
		if e != nil {
			return nil, e
		}
		return portal.NewLogin(pool, provider, portal.LoginOptions{ID: "official-account-entry", Name: "银河官方账户", RedirectURI: endpoint + "/v1/account/callback", Namespace: "official-account:" + accountScope, IncludeProfile: true, Renewal: account.Renewal != nil})
	}
	if len(observed) > 0 {
		hash, e := identityConfigurationHash(providers)
		if e != nil {
			return nil, e
		}
		for _, capture := range observed {
			if capture != nil {
				capture(hash)
			}
		}
	}
	return g, nil
}
