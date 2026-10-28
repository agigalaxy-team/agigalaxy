package managementaccounts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	Issuer, AdminOrigin           string
	Reader                        Credential
	Writer                        *Credential
	AdministratorRole, ReaderRole string
	Transport                     http.RoundTripper
	Now                           func() time.Time
	EmailChanges                  EmailChanges
}
type EmailChanges interface {
	Available(context.Context) bool
	Request(context.Context, string, string, string, func() error) (Object, error)
}
type tokenCache struct {
	value string
	until float64
}
type Native struct {
	issuer, base, tokenURL, publicOrigin, privateOrigin, prefix, adminRole, readerRole string
	reader                                                                             Credential
	writer                                                                             *Credential
	client                                                                             *http.Client
	now                                                                                func() time.Time
	mu                                                                                 sync.Mutex
	tokens                                                                             map[string]tokenCache
	email                                                                              EmailChanges
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
	if c.AdministratorRole == "" {
		c.AdministratorRole = "galaxy-operations-administrator"
	}
	if c.ReaderRole == "" {
		c.ReaderRole = "galaxy-operations-reader"
	}
	if !rolePattern.MatchString(c.AdministratorRole) || !rolePattern.MatchString(c.ReaderRole) {
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
	return &Native{issuer: c.Issuer, base: origin + realm[1] + "/admin/realms/" + url.PathEscape(realm[2]) + "/", tokenURL: strings.TrimSuffix(c.Issuer, "/") + "/protocol/openid-connect/token", prefix: realm[1] + "/admin/realms/" + url.PathEscape(realm[2]) + "/users/", publicOrigin: public, privateOrigin: origin, adminRole: c.AdministratorRole, readerRole: c.ReaderRole, reader: c.Reader, writer: writer, now: now, email: c.EmailChanges, tokens: map[string]tokenCache{}, client: &http.Client{Transport: c.Transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("management identity redirect rejected") }}}, nil
}
func (n *Native) Issuer() string              { return n.issuer }
func (n *Native) ManagementConfigured() bool  { return n.writer != nil }
func (n *Native) EmailChangeConfigured() bool { return n.email != nil }
func (n *Native) EmailChangeAvailability(ctx context.Context) bool {
	return n.email != nil && n.email.Available(ctx)
}
func jsonResponse(r *http.Response) (any, error) {
	defer r.Body.Close()
	b, e := io.ReadAll(io.LimitReader(r.Body, 1048577))
	if e != nil || len(b) > 1048576 {
		return nil, nativeError("management_identity_response_invalid")
	}
	var out any
	if json.Unmarshal(b, &out) != nil {
		return nil, nativeError("management_identity_response_invalid")
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
		return "", nativeError("management_writer_not_configured")
	}
	if old := n.tokens[kind]; old.until > float64(n.now().Unix()) {
		return old.value, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {c.ClientID}, "client_secret": {c.ClientSecret}}
	req, e := http.NewRequestWithContext(ctx, "POST", n.tokenURL, strings.NewReader(form.Encode()))
	if e != nil {
		return "", nativeError("management_identity_client_unavailable")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r, e := n.client.Do(req)
	if e != nil {
		return "", nativeError("management_identity_client_unavailable")
	}
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		r.Body.Close()
		return "", nativeError("management_identity_client_unavailable")
	}
	v, e := jsonResponse(r)
	if e != nil {
		return "", e
	}
	o, _ := v.(map[string]any)
	value, ok := o["access_token"].(string)
	expires, xok := o["expires_in"].(float64)
	if !ok || protocol.TextLength(value) > 32768 || !xok || math.IsNaN(expires) || math.IsInf(expires, 0) || expires <= 10 {
		return "", nativeError("management_identity_response_invalid")
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
			return nil, nativeError("management_identity_unavailable")
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Accept", "application/json")
		r, e := n.client.Do(req)
		if e != nil {
			cancel()
			return nil, nativeError("management_identity_unavailable")
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
			return nil, nativeError("management_identity_read_forbidden")
		}
		if r.StatusCode < 200 || r.StatusCode >= 300 {
			r.Body.Close()
			cancel()
			return nil, nativeError("management_identity_unavailable")
		}
		v, e := jsonResponse(r)
		cancel()
		return v, e
	}
	return nil, nativeError("management_identity_unavailable")
}
func (n *Native) target(issuer, subject string) (string, error) {
	if issuer != n.issuer || !validSubject(subject) {
		return "", fault.New("management_identity_not_found", 404)
	}
	return "users/" + url.PathEscape(subject), nil
}
func nativeText(v any, max int) string {
	s, ok := v.(string)
	if !ok || protocol.TextLength(s) > max {
		return ""
	}
	return s
}
func (n *Native) view(ctx context.Context, v any) (*User, error) {
	o, ok := v.(map[string]any)
	_, enabled := o["enabled"].(bool)
	_, verified := o["emailVerified"].(bool)
	username, uok := o["username"].(string)
	if !ok || !validSubject(str(o["id"])) || !uok || !enabled || !verified {
		return nil, nativeError("management_identity_response_invalid")
	}
	// JS truthiness here only affects this native service-account marker.
	if nativeTruthy(o["serviceAccountClientId"]) {
		return nil, nil
	}
	path, _ := n.target(n.issuer, str(o["id"]))
	v, e := n.read(ctx, path+"/role-mappings/realm/composite", "read", false)
	if e != nil {
		return nil, e
	}
	roles, ok := v.([]any)
	if !ok || len(roles) > 4096 {
		return nil, nativeError("management_identity_response_invalid")
	}
	admission := "none"
	for _, v := range roles {
		r, _ := v.(map[string]any)
		if r["name"] == n.adminRole {
			admission = "administrator"
			break
		}
		if r["name"] == n.readerRole {
			admission = "reader"
		}
	}
	var email, created *string
	if value, ok := o["email"].(string); ok && protocol.TextLength(value) <= 320 {
		email = &value
	}
	if ms, ok := o["createdTimestamp"].(float64); ok && ms >= 0 && ms == math.Trunc(ms) && ms <= 8640000000000000 {
		s := stamp(time.UnixMilli(int64(ms)))
		created = &s
	}
	actions := []string{}
	if values, ok := o["requiredActions"].([]any); ok {
		for _, v := range values {
			a := str(v)
			switch a {
			case "UPDATE_PASSWORD", "UPDATE_PROFILE", "VERIFY_EMAIL", "UPDATE_EMAIL", "CONFIGURE_TOTP":
				actions = append(actions, a)
			}
		}
	}
	return &User{n.issuer, str(o["id"]), nativeText(username, 200), nativeText(o["firstName"], 100), nativeText(o["lastName"], 100), email, o["emailVerified"] == true, o["enabled"] == true, created, admission, actions}, nil
}
func nativeTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0 && !math.IsNaN(x)
	}
	return true
}
func (n *Native) Count(ctx context.Context) (int64, error) {
	v, e := n.read(ctx, "users/count", "read", false)
	if e != nil {
		return 0, e
	}
	num, ok := v.(float64)
	if !ok || num < 0 || num != math.Trunc(num) || num > 9007199254740991 {
		return 0, nativeError("management_identity_response_invalid")
	}
	return int64(num), nil
}
func (n *Native) Page(ctx context.Context, first int64, max int) (Page, error) {
	if first < 0 || first > 9007199254740991 || max < 1 || max > 100 {
		return Page{}, fault.New("invalid_management_accounts_request", 400)
	}
	v, e := n.read(ctx, "users?first="+strconv.FormatInt(first, 10)+"&max="+strconv.Itoa(max)+"&briefRepresentation=false", "read", false)
	if e != nil {
		return Page{}, e
	}
	rows, ok := v.([]any)
	if !ok || len(rows) > max {
		return Page{}, nativeError("management_identity_response_invalid")
	}
	users := make([]*User, len(rows))
	errs := make([]error, len(rows))
	jobs := make(chan int)
	var wg sync.WaitGroup
	for k := 0; k < 4 && k < len(rows); k++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				users[i], errs[i] = n.view(ctx, rows[i])
			}
		}()
	}
	for i := range rows {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	out := Page{Items: []User{}, RawCount: int64(len(rows))}
	for i, u := range users {
		if errs[i] != nil {
			return Page{}, errs[i]
		}
		if u != nil {
			out.Items = append(out.Items, *u)
		}
	}
	return out, nil
}
func (n *Native) Get(ctx context.Context, issuer, subject string) (*User, error) {
	path, e := n.target(issuer, subject)
	if e != nil {
		return nil, e
	}
	v, e := n.read(ctx, path, "read", true)
	if e != nil || v == nil {
		return nil, e
	}
	o, _ := v.(map[string]any)
	if o["id"] != subject {
		return nil, nativeError("management_identity_response_invalid")
	}
	return n.view(ctx, v)
}

// Every native submission follows current authorization and is sent once.
// Unknown submission state must be resolved by the original operation receipt.
func (n *Native) write(ctx context.Context, path, method string, body any, authorize func() error) (Object, error) {
	if authorize == nil {
		return nil, nativeError("operations_authorization_unavailable")
	}
	token, e := n.token(ctx, "write")
	if e != nil {
		return nil, e
	}
	if e = authorize(); e != nil {
		return nil, e
	}
	var reader io.Reader
	if body != nil {
		b, e := protocol.EncodeJS(body)
		if e != nil {
			return nil, e
		}
		reader = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, method, n.base+path, reader)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	r, e := n.client.Do(req)
	if e != nil {
		return Object{"state": "unknown", "code": "management_identity_submission_unknown"}, nil
	}
	defer r.Body.Close()
	if r.StatusCode == 204 {
		return Object{"state": "confirmed", "code": nil}, nil
	}
	if r.StatusCode == 201 {
		return Object{"state": "confirmed", "code": nil, "location": r.Header.Get("Location")}, nil
	}
	state, code := "failed", "management_identity_write_failed"
	switch r.StatusCode {
	case 403:
		code = "management_identity_write_forbidden"
	case 401:
		code = "management_identity_client_unavailable"
	case 404:
		code = "management_identity_not_found"
	case 409:
		code = "management_username_conflict"
	case 400:
		code = "management_password_policy_rejected"
	}
	if r.StatusCode >= 500 {
		state = "unknown"
		code = "management_identity_submission_unknown"
	}
	return Object{"state": state, "code": code}, nil
}
func (n *Native) Create(ctx context.Context, input Object, authorize func() error) (Object, error) {
	r, e := n.write(ctx, "users", "POST", Object{"username": input["username"], "firstName": input["firstName"], "lastName": input["lastName"], "enabled": true, "requiredActions": []string{"UPDATE_PASSWORD"}, "credentials": []any{Object{"type": "password", "value": input["temporaryPassword"], "temporary": true}}}, authorize)
	if e != nil || r["state"] != "confirmed" {
		return r, e
	}
	base, _ := url.Parse(n.base)
	l, e := url.Parse(str(r["location"]))
	if e == nil {
		l = base.ResolveReference(l)
	}
	if e != nil {
		return Object{"state": "unknown", "code": "management_identity_response_invalid"}, nil
	}
	subject := ""
	if strings.HasPrefix(l.EscapedPath(), n.prefix) {
		subject, e = url.PathUnescape(strings.TrimPrefix(l.EscapedPath(), n.prefix))
	}
	origin := l.Scheme + "://" + l.Host
	if e != nil || (origin != n.publicOrigin && origin != n.privateOrigin) || l.RawQuery != "" || l.Fragment != "" || !validSubject(subject) {
		return Object{"state": "unknown", "code": "management_identity_response_invalid"}, nil
	}
	return Object{"state": "confirmed", "code": nil, "issuer": n.issuer, "externalSubject": subject}, nil
}
func (n *Native) Profile(ctx context.Context, issuer, subject string, fields Object, authorize func() error) (Object, error) {
	path, e := n.target(issuer, subject)
	if e != nil {
		return nil, e
	}
	body := Object{}
	for _, k := range []string{"firstName", "lastName"} {
		if v, ok := fields[k]; ok {
			body[k] = v
		}
	}
	return n.write(ctx, path, "PUT", body, authorize)
}
func (n *Native) SetEnabled(ctx context.Context, issuer, subject string, enabled bool, authorize func() error) (Object, error) {
	path, e := n.target(issuer, subject)
	if e != nil {
		return nil, e
	}
	return n.write(ctx, path, "PUT", Object{"enabled": enabled}, authorize)
}
func (n *Native) ResetPassword(ctx context.Context, issuer, subject, password string, authorize func() error) (Object, error) {
	path, e := n.target(issuer, subject)
	if e != nil {
		return nil, e
	}
	return n.write(ctx, path+"/reset-password", "PUT", Object{"type": "password", "value": password, "temporary": true}, authorize)
}
func (n *Native) Logout(ctx context.Context, issuer, subject string, authorize func() error) (Object, error) {
	path, e := n.target(issuer, subject)
	if e != nil {
		return nil, e
	}
	return n.write(ctx, path+"/logout", "POST", nil, authorize)
}
func (n *Native) Remove(ctx context.Context, issuer, subject string, authorize func() error) (Object, error) {
	path, e := n.target(issuer, subject)
	if e != nil {
		return nil, e
	}
	return n.write(ctx, path, "DELETE", nil, authorize)
}
func (n *Native) Sessions(ctx context.Context, issuer, subject string) (Object, error) {
	path, e := n.target(issuer, subject)
	if e != nil {
		return nil, e
	}
	v, e := n.read(ctx, path+"/sessions", "read", false)
	if e != nil {
		return nil, e
	}
	rows, ok := v.([]any)
	if !ok || len(rows) > 10000 {
		return nil, nativeError("management_identity_response_invalid")
	}
	return Object{"state": "available", "activeCount": len(rows), "scope": "keycloak-management-sso"}, nil
}
func (n *Native) Admission(ctx context.Context, issuer, subject, admission string, authorize func() error) (Object, error) {
	if admission != "administrator" && admission != "reader" {
		return nil, fault.New("invalid_management_accounts_request", 400)
	}
	path, e := n.target(issuer, subject)
	if e != nil {
		return nil, e
	}
	path += "/role-mappings/realm"
	a, e := n.read(ctx, path+"/composite", "read", false)
	if e != nil {
		return nil, e
	}
	b, e := n.read(ctx, path+"/available", "write", false)
	if e != nil {
		return nil, e
	}
	assigned, aok := a.([]any)
	available, bok := b.([]any)
	if !aok || !bok || len(assigned)+len(available) > 8192 {
		return nil, nativeError("management_identity_response_invalid")
	}
	fixed := func(name string) (Object, error) {
		id := ""
		for _, v := range append(assigned, available...) {
			r, _ := v.(map[string]any)
			if r["name"] != name {
				continue
			}
			if !validSubject(str(r["id"])) || r["clientRole"] == true || id != "" && id != str(r["id"]) {
				return nil, nativeError("management_identity_response_invalid")
			}
			id = str(r["id"])
		}
		if id == "" {
			return nil, nativeError("management_identity_response_invalid")
		}
		return Object{"id": id, "name": name}, nil
	}
	name := n.adminRole
	if admission == "reader" {
		name = n.readerRole
	}
	role, e := fixed(name)
	if e != nil {
		return nil, e
	}
	var admin Object
	if admission == "reader" {
		admin, e = fixed(n.adminRole)
		if e != nil {
			return nil, e
		}
	}
	r, e := n.write(ctx, path, "POST", []any{role}, authorize)
	if e != nil || r["state"] != "confirmed" || admin == nil {
		return r, e
	}
	return n.write(ctx, path, "DELETE", []any{admin}, authorize)
}
func (n *Native) RequestEmailChange(ctx context.Context, issuer, subject, email, operationID string, authorize func() error) (Object, error) {
	if _, e := n.target(issuer, subject); e != nil {
		return nil, e
	}
	if n.email == nil || !n.email.Available(ctx) {
		return nil, nativeError("management_email_verification_not_configured")
	}
	return n.email.Request(ctx, subject, email, operationID, authorize)
}
