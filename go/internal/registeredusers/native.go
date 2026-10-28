package registeredusers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Credential struct{ ClientID, ClientSecret string }
type NativeConfig struct {
	Issuer, AdminOrigin string
	Reader              Credential
	Writer              *Credential
	Transport           http.RoundTripper
	Now                 func() time.Time
}
type tokenCache struct {
	value string
	until float64
}
type Native struct {
	issuer, base, tokenURL, publicOrigin, privateOrigin, prefix string
	reader                                                      Credential
	writer                                                      *Credential
	client                                                      *http.Client
	now                                                         func() time.Time
	mu                                                          sync.Mutex
	tokens                                                      map[string]tokenCache
}

var realmPattern = regexp.MustCompile(`^(.*)/realms/([A-Za-z0-9._-]{1,128})/?$`)
var subjectPattern = regexp.MustCompile(`^[A-Za-z0-9._:@-]{1,255}$`)
var rolePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

func validSubject(s string) bool    { return s != "." && s != ".." && subjectPattern.MatchString(s) }
func nativeError(code string) error { return fault.New(code, 503) }
func NewNative(c NativeConfig) (*Native, error) {
	bad := func() (*Native, error) { return nil, fault.New("server_configuration_invalid", 400) }
	u, e := url.Parse(c.Issuer)
	if e != nil {
		return bad()
	}
	realm := realmPattern.FindStringSubmatch(u.Path)
	clean := func(u *url.URL) bool { return u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" }
	if len(realm) != 3 || !clean(u) || u.Scheme != "https" || c.Reader.ClientID == "" || c.Reader.ClientSecret == "" {
		return bad()
	}
	public := u.Scheme + "://" + u.Host
	origin := c.AdminOrigin
	if origin == "" {
		origin = public
	}
	a, e := url.Parse(origin)
	if e != nil || !clean(a) || a.Path != "" || a.Scheme != "https" && !(a.Scheme == "http" && (a.Hostname() == "127.0.0.1" || a.Hostname() == "::1")) {
		return bad()
	}
	if c.Writer != nil && (c.Writer.ClientID == "" || c.Writer.ClientSecret == "" || c.Writer.ClientID == c.Reader.ClientID) {
		return bad()
	}
	now := c.Now
	if now == nil {
		now = time.Now
	}
	var writer *Credential
	if c.Writer != nil {
		copy := *c.Writer
		writer = &copy
	}
	return &Native{issuer: c.Issuer, base: origin + realm[1] + "/admin/realms/" + url.PathEscape(realm[2]) + "/", tokenURL: strings.TrimSuffix(c.Issuer, "/") + "/protocol/openid-connect/token", prefix: realm[1] + "/admin/realms/" + url.PathEscape(realm[2]) + "/users/", publicOrigin: public, privateOrigin: origin, reader: c.Reader, writer: writer, now: now, tokens: map[string]tokenCache{}, client: &http.Client{Transport: c.Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("registered identity redirect rejected") }}}, nil
}
func jsonResponse(r *http.Response) (any, error) {
	defer r.Body.Close()
	b, e := io.ReadAll(io.LimitReader(r.Body, 1048577))
	if e != nil || len(b) > 1048576 {
		return nil, nativeError("registered_identity_unavailable")
	}
	var out any
	if json.Unmarshal(b, &out) != nil {
		return nil, nativeError("registered_identity_response_invalid")
	}
	return out, nil
}
func (n *Native) token(ctx context.Context, kind string) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	c := &n.reader
	if kind == "write" {
		c = n.writer
	}
	if c == nil {
		return "", nativeError("registered_identity_management_not_configured")
	}
	if old := n.tokens[kind]; old.until > float64(n.now().Unix()) {
		return old.value, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {c.ClientID}, "client_secret": {c.ClientSecret}}
	req, e := http.NewRequestWithContext(ctx, "POST", n.tokenURL, strings.NewReader(form.Encode()))
	if e != nil {
		return "", nativeError("registered_identity_unavailable")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r, e := n.client.Do(req)
	if e != nil {
		return "", nativeError("registered_identity_unavailable")
	}
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		r.Body.Close()
		return "", nativeError("registered_identity_client_unavailable")
	}
	v, e := jsonResponse(r)
	if e != nil {
		return "", e
	}
	o, _ := v.(map[string]any)
	value, ok := o["access_token"].(string)
	expires, xok := o["expires_in"].(float64)
	if !ok || protocol.TextLength(value) > 32768 || !xok || math.IsNaN(expires) || math.IsInf(expires, 0) || expires <= 10 {
		return "", nativeError("registered_identity_unavailable")
	}
	n.tokens[kind] = tokenCache{value, float64(n.now().Unix()) + math.Min(expires-5, 300)}
	return value, nil
}
func (n *Native) read(ctx context.Context, path, kind string, optional bool) (any, error) {
	for i := 0; i < 2; i++ {
		token, e := n.token(ctx, kind)
		if e != nil {
			return nil, e
		}
		rc, cancel := context.WithTimeout(ctx, 5*time.Second)
		req, e := http.NewRequestWithContext(rc, "GET", n.base+path, nil)
		if e != nil {
			cancel()
			return nil, nativeError("registered_identity_unavailable")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		r, e := n.client.Do(req)
		if e != nil {
			cancel()
			return nil, nativeError("registered_identity_unavailable")
		}
		if r.StatusCode == 401 && i == 0 {
			r.Body.Close()
			cancel()
			n.mu.Lock()
			delete(n.tokens, kind)
			n.mu.Unlock()
			continue
		}
		if r.StatusCode == 404 && optional {
			r.Body.Close()
			cancel()
			return nil, nil
		}
		if r.StatusCode == 403 {
			r.Body.Close()
			cancel()
			return nil, nativeError("registered_identity_read_forbidden")
		}
		if r.StatusCode < 200 || r.StatusCode >= 300 {
			r.Body.Close()
			cancel()
			return nil, nativeError("registered_identity_unavailable")
		}
		v, e := jsonResponse(r)
		cancel()
		return v, e
	}
	return nil, nativeError("registered_identity_unavailable")
}
func (n *Native) target(issuer, subject string) (string, error) {
	if issuer != n.issuer || !validSubject(subject) {
		return "", fault.New("registered_identity_target_invalid", 400)
	}
	return "users/" + url.PathEscape(subject), nil
}

func (n *Native) Issuer() string             { return n.issuer }
func (n *Native) ManagementConfigured() bool { return n.writer != nil }

var emailPattern = regexp.MustCompile(`^[^\s@<>]+@[^\s@<>]+$`)

func (n *Native) view(v any) (*User, error) {
	o, ok := v.(map[string]any)
	_, enabled := o["enabled"].(bool)
	_, verified := o["emailVerified"].(bool)
	if !ok || !validSubject(str(o["id"])) || !enabled || !verified {
		return nil, nativeError("registered_identity_response_invalid")
	}
	u := &User{Issuer: n.issuer, ExternalSubject: str(o["id"]), EmailVerified: o["emailVerified"] == true, Enabled: o["enabled"] == true, ServiceAccount: str(o["serviceAccountClientId"]) != "", Federated: str(o["federationLink"]) != "", Local: !strings.HasPrefix(str(o["id"]), "f:"), RequiredActions: []string{}, ManagementAllowed: obj(o["access"])["manage"] == true}
	if s, ok := o["email"].(string); ok && protocol.TextLength(s) <= 320 && emailPattern.MatchString(s) && !strings.ContainsFunc(s, func(r rune) bool { return trim(string(r)) == "" }) {
		u.Email = &s
	}
	names := []string{}
	for _, k := range []string{"firstName", "lastName"} {
		if s, ok := o[k].(string); ok && trim(s) != "" {
			names = append(names, s)
		}
	}
	name := trim(strings.Join(names, " "))
	if name != "" && protocol.TextLength(name) <= 240 {
		u.DisplayName = &name
	}
	if ms, ok := o["createdTimestamp"].(float64); ok && ms >= 0 && ms == math.Trunc(ms) && ms <= 8640000000000000 {
		at := time.UnixMilli(int64(ms)).UTC()
		s := stamp(at)
		if at.Year() > 9999 {
			s = fmt.Sprintf("+%06d-%02d-%02dT%02d:%02d:%02d.%03dZ", at.Year(), at.Month(), at.Day(), at.Hour(), at.Minute(), at.Second(), at.Nanosecond()/1000000)
		}
		u.RegisteredAt = &s
	}
	if actions, ok := o["requiredActions"].([]any); ok {
		for _, v := range actions {
			if has([]string{"VERIFY_EMAIL", "UPDATE_PASSWORD", "UPDATE_PROFILE", "CONFIGURE_TOTP"}, str(v)) {
				u.RequiredActions = append(u.RequiredActions, str(v))
			}
		}
	}
	return u, nil
}
func (n *Native) Count(ctx context.Context) (int64, error) {
	v, e := n.read(ctx, "users/count", "read", false)
	if e != nil {
		return 0, e
	}
	f, ok := v.(float64)
	if !ok || f < 0 || f != math.Trunc(f) || f > 9007199254740991 {
		return 0, nativeError("registered_identity_response_invalid")
	}
	return int64(f), nil
}
func (n *Native) Page(ctx context.Context, first int64, max int) (Page, error) {
	if first < 0 || first > 9007199254740991 || max < 1 || max > 100 {
		return Page{}, invalid()
	}
	v, e := n.read(ctx, "users?first="+strconv.FormatInt(first, 10)+"&max="+strconv.Itoa(max)+"&briefRepresentation=false", "read", false)
	if e != nil {
		return Page{}, e
	}
	rows, ok := v.([]any)
	if !ok || len(rows) > max {
		return Page{}, nativeError("registered_identity_response_invalid")
	}
	p := Page{Items: []User{}, RawCount: int64(len(rows))}
	for _, v := range rows {
		u, e := n.view(v)
		if e != nil {
			return Page{}, e
		}
		if !u.ServiceAccount {
			p.Items = append(p.Items, *u)
		}
	}
	return p, nil
}
func (n *Native) Get(ctx context.Context, issuer, sub string) (*User, error) {
	path, e := n.target(issuer, sub)
	if e != nil {
		return nil, e
	}
	v, e := n.read(ctx, path, "read", true)
	if e != nil || v == nil {
		return nil, e
	}
	u, e := n.view(v)
	if e != nil {
		return nil, e
	}
	if u.ExternalSubject != sub {
		return nil, nativeError("registered_identity_response_invalid")
	}
	if u.ServiceAccount {
		return nil, nil
	}
	return u, nil
}
func (n *Native) Management(ctx context.Context, issuer, sub string) (Object, error) {
	if n.writer == nil {
		return Object{"state": "not-configured"}, nil
	}
	path, e := n.target(issuer, sub)
	if e == nil {
		var v any
		v, e = n.read(ctx, path, "write", true)
		if e == nil && v != nil {
			var u *User
			u, e = n.view(v)
			if e == nil && u.ManagementAllowed {
				return Object{"state": "available"}, nil
			}
		}
		if e == nil {
			return Object{"state": "forbidden"}, nil
		}
	}
	if fault.Code(e) == "registered_identity_read_forbidden" {
		return Object{"state": "forbidden"}, nil
	}
	return Object{"state": "unavailable"}, nil
}
func (n *Native) RegistrationEvidence(ctx context.Context, issuer, sub string) (Object, error) {
	path, e := n.target(issuer, sub)
	if e != nil {
		return nil, e
	}
	type result struct {
		index int
		v     any
		e     error
	}
	ch := make(chan result, 2)
	for index, suffix := range []string{"/credentials", "/federated-identity"} {
		go func(index int, s string) { v, e := n.read(ctx, path+s, "read", false); ch <- result{index, v, e} }(index, suffix)
	}
	values := [2]any{}
	for range 2 {
		r := <-ch
		if r.e != nil {
			return nil, r.e
		}
		values[r.index] = r.v
	}
	credentials, federation := values[0], values[1]
	c, cok := credentials.([]any)
	f, fok := federation.([]any)
	if !cok || !fok || len(c) > 1000 || len(f) > 1000 {
		return nil, nativeError("registered_identity_response_invalid")
	}
	return Object{"hasCredentials": len(c) > 0, "hasFederatedIdentities": len(f) > 0}, nil
}
func (n *Native) SessionSummary(ctx context.Context, issuer, sub string) (Object, error) {
	path, e := n.target(issuer, sub)
	if e != nil {
		return nil, e
	}
	v, e := n.read(ctx, path+"/sessions", "read", false)
	if e != nil {
		return nil, e
	}
	rows, ok := v.([]any)
	if !ok || len(rows) > 10000 {
		return nil, nativeError("registered_identity_response_invalid")
	}
	return Object{"state": "available", "activeCount": len(rows), "scope": "keycloak-user-sso"}, nil
}
func (n *Native) write(ctx context.Context, issuer, sub, suffix, method string, body any, authorize func() error) (Object, error) {
	if authorize == nil {
		return nil, nativeError("operations_authorization_unavailable")
	}
	path, e := n.target(issuer, sub)
	if e != nil {
		return nil, e
	}
	token, e := n.token(ctx, "write")
	if e != nil {
		return nil, e
	}
	if e = authorize(); e != nil {
		return nil, e
	}
	var data io.Reader
	if body != nil {
		b, e := protocol.EncodeJS(body)
		if e != nil {
			return nil, e
		}
		data = bytes.NewReader(b)
	}
	rc, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(rc, method, n.base+path+suffix, data)
	if e != nil {
		return nil, e
	}
	req.GetBody = nil
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	r, e := n.client.Do(req)
	if e != nil {
		return Object{"state": "unknown", "code": "registered_identity_submission_unknown"}, nil
	}
	r.Body.Close()
	if r.StatusCode == 204 {
		return Object{"state": "confirmed", "code": nil}, nil
	}
	code := "registered_identity_write_failed"
	switch r.StatusCode {
	case 403:
		code = "registered_identity_write_forbidden"
	case 401:
		code = "registered_identity_client_unavailable"
	case 404:
		code = "registered_identity_not_found"
	case 409:
		code = "registered_identity_changed"
	}
	return Object{"state": "failed", "code": code}, nil
}
func (n *Native) SetEnabled(ctx context.Context, i, s string, enabled bool, a func() error) (Object, error) {
	return n.write(ctx, i, s, "", "PUT", Object{"enabled": enabled}, a)
}
func (n *Native) Logout(ctx context.Context, i, s string, a func() error) (Object, error) {
	return n.write(ctx, i, s, "/logout", "POST", nil, a)
}
func (n *Native) ResetLink(ctx context.Context, i, s string, a func() error) (Object, error) {
	r, e := n.write(ctx, i, s, "/execute-actions-email", "PUT", []string{"UPDATE_PASSWORD"}, a)
	if e == nil && r["state"] == "confirmed" {
		r["state"] = "submitted"
	}
	return r, e
}
