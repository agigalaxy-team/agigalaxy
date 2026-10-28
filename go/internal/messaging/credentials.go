package messaging

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

type CredentialBinding struct {
	Ref      string   `json:"ref"`
	Label    string   `json:"label"`
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	TLS      string   `json:"tls"`
	Purposes []string `json:"purposes"`
	User     string   `json:"user"`
	Password string   `json:"password"`
}
type CredentialView struct {
	Ref       string   `json:"ref"`
	Label     string   `json:"label"`
	Host      string   `json:"host"`
	Port      int      `json:"port"`
	TLS       string   `json:"tls"`
	Purposes  []string `json:"purposes"`
	Available bool     `json:"available"`
}
type CredentialSelection struct {
	Ref, Host, TLS, Purpose string
	Port                    int
}
type CredentialResolver interface {
	List() ([]CredentialView, error)
	Resolve(CredentialSelection) (*Credentials, error)
}
type bindingResolver struct{ entries []CredentialBinding }

var smtpRef = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var smtpHost = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`)

func NewCredentialResolver(entries []CredentialBinding) (CredentialResolver, error) {
	rows := make([]CredentialBinding, len(entries))
	seen := map[string]bool{}
	for i, input := range entries {
		entry := input
		entry.Label = strings.TrimSpace(entry.Label)
		entry.Host = strings.ToLower(strings.TrimSpace(entry.Host))
		if !smtpRef.MatchString(entry.Ref) || len([]rune(entry.Label)) < 1 || len([]rune(entry.Label)) > 100 || len(entry.Host) > 253 || !smtpHost.MatchString(entry.Host) || strings.Contains(entry.Host, "..") || entry.Port < 1 || entry.Port > 65535 || !oneTLS(entry.TLS) || len(entry.Purposes) < 1 || len(entry.Purposes) > 5 || len([]rune(entry.User)) < 1 || len([]rune(entry.User)) > 320 || len([]rune(entry.Password)) < 1 || len([]rune(entry.Password)) > 4096 || seen[entry.Ref] {
			return nil, fault.New("smtp_credential_configuration_invalid", 503)
		}
		purposes := map[string]bool{}
		for _, key := range entry.Purposes {
			if _, ok := OfficialMailIdentities[key]; !ok || purposes[key] {
				return nil, fault.New("smtp_credential_configuration_invalid", 503)
			}
			purposes[key] = true
		}
		entry.Purposes = append([]string(nil), entry.Purposes...)
		rows[i] = entry
		seen[entry.Ref] = true
	}
	return &bindingResolver{entries: rows}, nil
}
func (r *bindingResolver) List() ([]CredentialView, error) {
	out := make([]CredentialView, 0, len(r.entries))
	for _, row := range r.entries {
		out = append(out, CredentialView{Ref: row.Ref, Label: row.Label, Host: row.Host, Port: row.Port, TLS: row.TLS, Purposes: append([]string(nil), row.Purposes...), Available: true})
	}
	return out, nil
}
func (r *bindingResolver) Resolve(selection CredentialSelection) (*Credentials, error) {
	for _, row := range r.entries {
		if row.Ref != selection.Ref {
			continue
		}
		purpose := selection.Purpose == ""
		for _, key := range row.Purposes {
			purpose = purpose || key == selection.Purpose
		}
		if row.Host != selection.Host || row.Port != selection.Port || row.TLS != selection.TLS || !purpose {
			return nil, fault.New("smtp_credential_binding_mismatch", 409)
		}
		return &Credentials{User: row.User, Password: row.Password}, nil
	}
	return nil, nil
}

type credentialDocument struct {
	Version     int                 `json:"version"`
	Endpoint    string              `json:"endpoint"`
	Credentials []CredentialBinding `json:"credentials"`
}

func loadCredentials(path, endpoint string, refreshing bool) (CredentialResolver, error) {
	if !filepath.IsAbs(path) {
		return nil, fault.New("system_settings_private_configuration_invalid", 503)
	}
	info, e := os.Lstat(path)
	if e != nil || !info.Mode().IsRegular() || info.Size() > 65536 || (runtime.GOOS != "windows" && info.Mode().Perm()&0007 != 0) {
		return nil, fault.New("system_settings_private_configuration_invalid", 503)
	}
	if refreshing && !rootOwned(info) {
		return nil, fault.New("system_settings_private_configuration_invalid", 503)
	}
	file, e := os.Open(path)
	if e != nil {
		return nil, fault.New("system_settings_private_configuration_invalid", 503)
	}
	defer file.Close()
	raw, e := io.ReadAll(io.LimitReader(file, 65537))
	if e != nil || len(raw) > 65536 {
		return nil, fault.New("system_settings_private_configuration_invalid", 503)
	}
	var document credentialDocument
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&document) != nil || d.Decode(new(any)) != io.EOF || document.Version != 1 || document.Endpoint != endpoint || document.Credentials == nil || len(document.Credentials) > 32 {
		return nil, fault.New("system_settings_private_configuration_invalid", 503)
	}
	resolver, e := NewCredentialResolver(document.Credentials)
	if e != nil {
		return nil, fault.New("system_settings_private_configuration_invalid", 503)
	}
	return resolver, nil
}
func LoadCredentials(path, endpoint string) (CredentialResolver, error) {
	if path == "" {
		return NewCredentialResolver(nil)
	}
	return loadCredentials(path, endpoint, false)
}

type refreshingResolver struct{ path, endpoint string }

func NewRefreshingCredentials(path, endpoint string) (CredentialResolver, error) {
	if _, e := loadCredentials(path, endpoint, true); e != nil {
		return nil, e
	}
	return &refreshingResolver{path: path, endpoint: endpoint}, nil
}
func (r *refreshingResolver) List() ([]CredentialView, error) {
	current, e := loadCredentials(r.path, r.endpoint, true)
	if e != nil {
		return nil, e
	}
	return current.List()
}
func (r *refreshingResolver) Resolve(selection CredentialSelection) (*Credentials, error) {
	current, e := loadCredentials(r.path, r.endpoint, true)
	if e != nil {
		return nil, e
	}
	return current.Resolve(selection)
}
