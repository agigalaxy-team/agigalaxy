package access

import (
	"context"
	"encoding/json"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type DirectoryIdentity struct {
	Issuer, ExternalSubject, State, Email string
	Enabled, EmailVerified                bool
}

func directoryEmail(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || protocol.TextLength(s) > 320 {
		return "", false
	}
	at := strings.IndexByte(s, '@')
	if at <= 0 || at != strings.LastIndexByte(s, '@') || at == len(s)-1 {
		return "", false
	}
	for _, c := range s {
		if c == '<' || c == '>' || strings.ContainsRune("\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff", c) {
			return "", false
		}
	}
	return s, true
}

// LookupIdentity reads current native identity fields every time. The directory
// role cache cannot establish a delivery address or email-verification state.
func (d *KeycloakDirectory) LookupIdentity(ctx context.Context, issuer, subject string) (DirectoryIdentity, error) {
	out := DirectoryIdentity{Issuer: issuer, ExternalSubject: subject, State: "not-found"}
	if d == nil || issuer != d.issuer || !subjectPattern.MatchString(subject) {
		return out, nil
	}
	var value any
	if e := d.read(ctx, "users/"+url.PathEscape(subject), true, &value); e != nil {
		return DirectoryIdentity{}, e
	}
	user, ok := value.(map[string]any)
	if !ok || user["id"] != subject {
		return out, nil
	}
	out.State = "available"
	out.Enabled = user["enabled"] == true
	out.EmailVerified = user["emailVerified"] == true
	out.Email, _ = directoryEmail(user["email"])
	return out, nil
}

var directoryClientID = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,199}$`)

// LoadAccountDirectory reads only the existing protected read-only business
// directory reference. It does not load a management or account writer secret.
func LoadAccountDirectory(file string) (*KeycloakDirectory, error) {
	if file == "" {
		return nil, nil
	}
	var values map[string]json.RawMessage
	if e := protectedJSON(file, 16384, &values); e != nil {
		return nil, e
	}
	invalid := func() (*KeycloakDirectory, error) { return nil, fault.New("server_configuration_invalid", 400) }
	var version int
	var managementIssuer, directoryOrigin string
	if json.Unmarshal(values["version"], &version) != nil || version != 1 || json.Unmarshal(values["issuer"], &managementIssuer) != nil {
		return invalid()
	}
	if value, ok := values["directoryOrigin"]; ok && json.Unmarshal(value, &directoryOrigin) != nil {
		return invalid()
	}
	var reference directoryReference
	var keys map[string]json.RawMessage
	if protocol.Decode(values["accountDirectory"], &reference) != nil || json.Unmarshal(values["accountDirectory"], &keys) != nil || keys["issuer"] == nil || keys["credentialFile"] == nil || reference.Issuer == managementIssuer {
		return invalid()
	}
	if _, ok := keys["writerCredentialFile"]; ok && (!filepath.IsAbs(reference.WriterCredentialFile) || reference.WriterCredentialFile == reference.CredentialFile) {
		return invalid()
	}
	var credential struct {
		Version      int    `json:"version"`
		ClientID     string `json:"clientId"`
		ClientSecret string `json:"clientSecret"`
	}
	if e := protectedJSON(reference.CredentialFile, 16384, &credential); e != nil {
		return nil, e
	}
	if credential.Version != 1 || !directoryClientID.MatchString(credential.ClientID) || credential.ClientSecret == "" || protocol.TextLength(credential.ClientSecret) > 4096 {
		return invalid()
	}
	return NewKeycloakDirectory(KeycloakConfig{Issuer: reference.Issuer, AdminOrigin: directoryOrigin, ClientID: credential.ClientID, ClientSecret: credential.ClientSecret})
}
