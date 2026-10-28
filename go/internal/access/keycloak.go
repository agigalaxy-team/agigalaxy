package access

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type KeycloakConfig struct {
	Issuer, AdminOrigin, ClientID, ClientSecret string
	AllowLoopbackHTTP                           bool
}
type roleEntry struct {
	roles   []string
	expires int64
}
type KeycloakDirectory struct {
	issuer, base, tokenURL, clientID, secret string
	client                                   *http.Client
	tokenMu                                  sync.Mutex
	token                                    string
	tokenExpires                             int64
	mu                                       sync.Mutex
	roles                                    map[string]roleEntry
	revision                                 uint64
	Now                                      func() time.Time
}

var subjectPattern = regexp.MustCompile(`^[A-Za-z0-9._:@-]{1,255}$`)
var realmPattern = regexp.MustCompile(`^(.*)/realms/([A-Za-z0-9._-]{1,128})/?$`)

func directoryUnavailable() error { return fault.New("operations_directory_unavailable", 503) }
func NewKeycloakDirectory(c KeycloakConfig) (*KeycloakDirectory, error) {
	u, e := url.Parse(c.Issuer)
	if e != nil {
		return nil, directoryUnavailable()
	}
	realm := realmPattern.FindStringSubmatch(u.Path)
	if len(realm) != 3 || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Scheme != "https" && !(c.AllowLoopbackHTTP && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) || c.ClientID == "" || c.ClientSecret == "" {
		return nil, directoryUnavailable()
	}
	origin := c.AdminOrigin
	if origin == "" {
		origin = u.Scheme + "://" + u.Host
	}
	a, e := url.Parse(origin)
	if e != nil || a.Host == "" || a.Path != "" || a.User != nil || a.RawQuery != "" || a.Fragment != "" || a.Scheme != "https" && !(a.Scheme == "http" && (a.Hostname() == "127.0.0.1" || a.Hostname() == "::1")) {
		return nil, directoryUnavailable()
	}
	return &KeycloakDirectory{issuer: c.Issuer, base: origin + realm[1] + "/admin/realms/" + url.PathEscape(realm[2]) + "/", tokenURL: origin + realm[1] + "/realms/" + url.PathEscape(realm[2]) + "/protocol/openid-connect/token", clientID: c.ClientID, secret: c.ClientSecret,
		client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, roles: map[string]roleEntry{}}, nil
}
func (d *KeycloakDirectory) now() int64 {
	if d.Now != nil {
		return d.Now().Unix()
	}
	return time.Now().Unix()
}
func (d *KeycloakDirectory) request(ctx context.Context, method, address string, form url.Values, token string) (int, json.RawMessage, error) {
	var body io.Reader
	if form != nil {
		body = strings.NewReader(form.Encode())
	}
	r, e := http.NewRequestWithContext(ctx, method, address, body)
	if e != nil {
		return 0, nil, directoryUnavailable()
	}
	r.Header.Set("Accept", "application/json")
	if form != nil {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	response, e := d.client.Do(r)
	if e != nil {
		return 0, nil, directoryUnavailable()
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return response.StatusCode, nil, nil
	}
	b, e := io.ReadAll(io.LimitReader(response.Body, 524289))
	if e != nil || len(b) > 524288 || !json.Valid(b) {
		return 0, nil, directoryUnavailable()
	}
	return response.StatusCode, b, nil
}
func (d *KeycloakDirectory) accessToken(ctx context.Context) (string, error) {
	d.tokenMu.Lock()
	defer d.tokenMu.Unlock()
	if d.token != "" && d.tokenExpires > d.now() {
		return d.token, nil
	}
	status, b, e := d.request(ctx, "POST", d.tokenURL, url.Values{"grant_type": {"client_credentials"}, "client_id": {d.clientID}, "client_secret": {d.secret}}, "")
	if e != nil || status != 200 {
		return "", directoryUnavailable()
	}
	var value struct {
		Token   string  `json:"access_token"`
		Expires float64 `json:"expires_in"`
	}
	if json.Unmarshal(b, &value) != nil || value.Token == "" || len(value.Token) > 32768 || value.Expires <= 10 {
		return "", directoryUnavailable()
	}
	d.token = value.Token
	d.tokenExpires = d.now() + int64(min(value.Expires-5, 300))
	return d.token, nil
}
func (d *KeycloakDirectory) read(ctx context.Context, path string, optional bool, target any) error {
	for attempt := 0; attempt < 2; attempt++ {
		token, e := d.accessToken(ctx)
		if e != nil {
			return e
		}
		status, b, e := d.request(ctx, "GET", d.base+path, nil, token)
		if e != nil {
			return e
		}
		if status == 401 && attempt == 0 {
			d.tokenMu.Lock()
			if d.token == token {
				d.token = ""
			}
			d.tokenMu.Unlock()
			continue
		}
		if status == 404 && optional {
			return nil
		}
		if status != 200 || json.Unmarshal(b, target) != nil {
			return directoryUnavailable()
		}
		return nil
	}
	return directoryUnavailable()
}
func (d *KeycloakDirectory) Roles(ctx context.Context, issuer, subject string) ([]string, error) {
	if issuer != d.issuer || !subjectPattern.MatchString(subject) {
		return []string{}, nil
	}
	d.mu.Lock()
	entry, ok := d.roles[subject]
	revision := d.revision
	d.mu.Unlock()
	if ok && entry.expires > d.now() {
		return append([]string(nil), entry.roles...), nil
	}
	roles, e := d.fetchRoles(ctx, subject)
	if e != nil {
		return nil, e
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if revision != d.revision {
		return nil, directoryUnavailable()
	}
	for id, v := range d.roles {
		if v.expires <= d.now() {
			delete(d.roles, id)
		}
	}
	if len(d.roles) >= 256 {
		var oldest string
		var at int64
		for id, v := range d.roles {
			if oldest == "" || v.expires < at {
				oldest, at = id, v.expires
			}
		}
		delete(d.roles, oldest)
	}
	d.roles[subject] = roleEntry{roles, d.now() + 15}
	return append([]string(nil), roles...), nil
}
func (d *KeycloakDirectory) fetchRoles(ctx context.Context, subject string) ([]string, error) {
	var user *struct {
		ID      string `json:"id"`
		Enabled bool   `json:"enabled"`
	}
	path := "users/" + url.PathEscape(subject)
	if e := d.read(ctx, path, true, &user); e != nil {
		return nil, e
	}
	roles := []string{}
	if user != nil && user.ID == subject && user.Enabled {
		var values []struct {
			Name string `json:"name"`
		}
		if e := d.read(ctx, path+"/role-mappings/realm/composite", false, &values); e != nil {
			return nil, e
		}
		if values == nil || len(values) > 4096 {
			return nil, directoryUnavailable()
		}
		for _, v := range values {
			if len(v.Name) <= 128 {
				roles = append(roles, v.Name)
			}
		}
	}
	return append([]string(nil), roles...), nil
}
func (d *KeycloakDirectory) RolesFresh(ctx context.Context, issuer, subject string) ([]string, error) {
	if issuer != d.issuer || !subjectPattern.MatchString(subject) {
		return []string{}, nil
	}
	d.mu.Lock()
	revision := d.revision
	d.mu.Unlock()
	roles, e := d.fetchRoles(ctx, subject)
	if e != nil {
		return nil, e
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if revision != d.revision {
		return nil, directoryUnavailable()
	}
	return roles, nil
}
func (d *KeycloakDirectory) Invalidate(issuer, subject string) bool {
	if issuer != d.issuer || !subjectPattern.MatchString(subject) {
		return false
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.revision++
	delete(d.roles, subject)
	return true
}
