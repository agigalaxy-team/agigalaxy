package access

import (
	"net/http"
	"net/url"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/managementaccounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// LoadManagementDirectory reuses the original protected operations references.
// The read-only business directory cannot become the management writer.
func LoadManagementDirectory(file string) (*managementaccounts.Native, error) {
	return loadManagementDirectory(file, nil)
}
func loadManagementDirectory(file string, transport http.RoundTripper) (*managementaccounts.Native, error) {
	if file == "" {
		return nil, nil
	}
	var c operationsConfiguration
	if e := protectedJSON(file, 16384, &c); e != nil {
		return nil, e
	}
	bad := func() (*managementaccounts.Native, error) { return nil, fault.New("server_configuration_invalid", 400) }
	var roles struct {
		Administrator string `json:"administrator"`
		Reader        string `json:"reader"`
	}
	if c.Version != 1 || !directoryClientID.MatchString(c.ClientID) || c.AccountDirectory.Issuer == "" || c.AccountDirectory.Issuer == c.Issuer || protocol.Decode(c.Roles, &roles) != nil || roles.Administrator == "" || roles.Reader == "" {
		return bad()
	}
	if c.AccountDirectory.WriterCredentialFile != "" && (!filepath.IsAbs(c.AccountDirectory.WriterCredentialFile) || c.AccountDirectory.WriterCredentialFile == c.AccountDirectory.CredentialFile) {
		return bad()
	}
	credential := func(path string) (managementaccounts.Credential, error) {
		var v struct {
			Version      int    `json:"version"`
			ClientID     string `json:"clientId"`
			ClientSecret string `json:"clientSecret"`
		}
		if e := protectedJSON(path, 16384, &v); e != nil {
			return managementaccounts.Credential{}, e
		}
		if v.Version != 1 || !directoryClientID.MatchString(v.ClientID) || v.ClientSecret == "" || protocol.TextLength(v.ClientSecret) > 4096 {
			return managementaccounts.Credential{}, fault.New("server_configuration_invalid", 400)
		}
		return managementaccounts.Credential{ClientID: v.ClientID, ClientSecret: v.ClientSecret}, nil
	}
	reader, e := credential(c.CredentialFile)
	if e != nil {
		return nil, e
	}
	business, e := credential(c.AccountDirectory.CredentialFile)
	if e != nil {
		return nil, e
	}
	var writer *managementaccounts.Credential
	var email managementaccounts.EmailChanges
	if c.Management != nil {
		var ref struct {
			Writer string `json:"writerCredentialFile"`
		}
		if protocol.Decode(c.Management, &ref) != nil || !filepath.IsAbs(ref.Writer) || ref.Writer == c.CredentialFile || ref.Writer == c.AccountDirectory.CredentialFile || ref.Writer == c.AccountDirectory.WriterCredentialFile {
			return bad()
		}
		v, e := credential(ref.Writer)
		if e != nil {
			return nil, e
		}
		if v.ClientID == reader.ClientID || v.ClientID == business.ClientID {
			return bad()
		}
		writer = &v
		origin := c.DirectoryOrigin
		if origin == "" {
			u, e := url.Parse(c.Issuer)
			if e != nil {
				return bad()
			}
			origin = u.Scheme + "://" + u.Host
		}
		email, e = managementaccounts.NewNativeEmail(c.Issuer, origin, writer, transport, nil)
		if e != nil {
			return nil, e
		}
	}
	return managementaccounts.NewNative(managementaccounts.NativeConfig{Issuer: c.Issuer, AdminOrigin: c.DirectoryOrigin, Reader: reader, Writer: writer, AdministratorRole: roles.Administrator, ReaderRole: roles.Reader, Transport: transport, EmailChanges: email})
}

func (g *Gateway) ManagementSessions() *managementaccounts.PortalSessions {
	return &managementaccounts.PortalSessions{Directory: &managementaccounts.Directory{Pool: g.Pool, Endpoint: g.Config.Endpoint, Now: g.Now}, Issuer: g.Config.OperatorIssuer, InvalidateRoles: func(issuer, subject string) bool {
		d, ok := g.Directory.(interface{ Invalidate(string, string) bool })
		return ok && d.Invalidate(issuer, subject)
	}}
}
