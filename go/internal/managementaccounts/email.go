package managementaccounts

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// NativeEmail is the existing native-update-email extension. SMTP delivery and
// address verification remain at that extension, never an administrative PUT.
type NativeEmail struct {
	base, tokenURL, host, issuer string
	writer                       *Credential
	client                       *http.Client
	now                          func() time.Time
	mu                           sync.Mutex
	cached                       tokenCache
}

func NewNativeEmail(issuer, privateOrigin string, writer *Credential, transport http.RoundTripper, now func() time.Time) (*NativeEmail, error) {
	u, e := url.Parse(issuer)
	if e != nil {
		return nil, nativeError("server_configuration_invalid")
	}
	a, e := url.Parse(privateOrigin)
	if e != nil {
		return nil, nativeError("server_configuration_invalid")
	}
	clean := func(u *url.URL) bool { return u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" }
	if u.Scheme != "https" || !strings.HasSuffix(u.Path, "/realms/galaxy-operations") || !clean(u) || !clean(a) || a.Path != "" || a.Scheme != "https" && !(a.Scheme == "http" && (a.Hostname() == "127.0.0.1" || a.Hostname() == "::1")) || writer != nil && (writer.ClientID != "galaxy-management-account-maintenance" || writer.ClientSecret == "" || protocol.TextLength(writer.ClientSecret) > 16384) {
		return nil, nativeError("server_configuration_invalid")
	}
	if now == nil {
		now = time.Now
	}
	var copy *Credential
	if writer != nil {
		c := *writer
		copy = &c
	}
	return &NativeEmail{base: privateOrigin + u.Path + "/galaxy-management/", tokenURL: privateOrigin + u.Path + "/protocol/openid-connect/token", host: u.Host, issuer: issuer, writer: copy, now: now, client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("management email redirect rejected") }}}, nil
}
func emailJSON(r *http.Response) (Object, error) {
	defer r.Body.Close()
	b, e := io.ReadAll(io.LimitReader(r.Body, 65537))
	if e != nil || len(b) > 65536 {
		return nil, nativeError("management_identity_response_invalid")
	}
	var out Object
	if json.Unmarshal(b, &out) != nil {
		return nil, nativeError("management_identity_response_invalid")
	}
	return out, nil
}
func (n *NativeEmail) token(ctx context.Context) (string, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.writer == nil {
		return "", nativeError("management_writer_not_configured")
	}
	if n.cached.until > float64(n.now().Unix()) {
		return n.cached.value, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {n.writer.ClientID}, "client_secret": {n.writer.ClientSecret}}
	r, e := http.NewRequestWithContext(ctx, "POST", n.tokenURL, strings.NewReader(form.Encode()))
	if e != nil {
		return "", nativeError("management_identity_client_unavailable")
	}
	r.Host = n.host
	r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	r.Header.Set("Accept", "application/json")
	response, e := n.client.Do(r)
	if e != nil {
		return "", nativeError("management_identity_client_unavailable")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return "", nativeError("management_identity_client_unavailable")
	}
	o, e := emailJSON(response)
	if e != nil {
		return "", e
	}
	token, ok := o["access_token"].(string)
	seconds, x := o["expires_in"].(float64)
	if !ok || token == "" || protocol.TextLength(token) > 32768 || !x || seconds != math.Trunc(seconds) || seconds <= 5 || seconds > 9007199254740991 {
		return "", nativeError("management_identity_response_invalid")
	}
	n.cached = tokenCache{token, float64(n.now().Unix()) + math.Min(seconds-5, 300)}
	return token, nil
}
func (n *NativeEmail) clear() { n.mu.Lock(); n.cached = tokenCache{}; n.mu.Unlock() }
func (n *NativeEmail) Available(ctx context.Context) bool {
	if n.writer == nil {
		return false
	}
	token, e := n.token(ctx)
	if e != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	r, e := http.NewRequestWithContext(ctx, "GET", n.base+"email-change-capabilities", nil)
	if e != nil {
		return false
	}
	r.Host = n.host
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Accept", "application/json")
	response, e := n.client.Do(r)
	if e != nil {
		return false
	}
	if response.StatusCode == 401 {
		n.clear()
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		response.Body.Close()
		return false
	}
	o, e := emailJSON(response)
	return e == nil && o["version"] == float64(1) && o["available"] == true && o["mode"] == "native-update-email" && o["verificationBeforeChange"] == true && o["metadataOnly"] == true
}
func (n *NativeEmail) Request(ctx context.Context, subject, email, operationID string, authorize func() error) (Object, error) {
	if !validSubject(subject) || !regexpEmailUUID(operationID) || email == "" || protocol.TextLength(email) > 320 || trim(email) != email {
		return nil, invalid()
	}
	for _, c := range email {
		if c < 32 || c == 127 {
			return nil, invalid()
		}
	}
	if authorize == nil {
		return nil, nativeError("operations_authorization_unavailable")
	}
	if !n.Available(ctx) {
		return nil, nativeError("management_email_verification_not_configured")
	}
	token, e := n.token(ctx)
	if e != nil {
		return nil, e
	}
	if e = authorize(); e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	body := jsonText(Object{"operationId": operationID, "newEmail": email})
	r, e := http.NewRequestWithContext(ctx, "POST", n.base+"users/"+url.PathEscape(subject)+"/email-change", strings.NewReader(body))
	if e != nil {
		return nil, e
	}
	r.Host = n.host
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Accept", "application/json")
	r.Header.Set("Content-Type", "application/json")
	response, e := n.client.Do(r)
	if e != nil {
		return Object{"state": "unknown", "code": "management_identity_submission_unknown"}, nil
	}
	if response.StatusCode == 401 {
		n.clear()
	}
	o, e := emailJSON(response)
	if e != nil {
		return Object{"state": "unknown", "code": "management_identity_response_invalid"}, nil
	}
	if response.StatusCode == 202 && o["version"] == float64(1) && o["operationId"] == operationID && o["metadataOnly"] == true && whole(o["expiresAt"], 1, 9007199254740991) {
		if o["state"] == "submitted" && o["code"] == nil {
			return Object{"state": "submitted", "code": nil}, nil
		}
		if o["state"] == "unknown" && o["code"] == "management_identity_submission_unknown" {
			return Object{"state": "unknown", "code": o["code"]}, nil
		}
	}
	if response.StatusCode >= 500 {
		return Object{"state": "unknown", "code": "management_identity_submission_unknown"}, nil
	}
	if response.StatusCode == 400 || response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 404 || response.StatusCode == 409 {
		code := str(o["code"])
		if !includes([]string{"management_identity_client_unavailable", "management_identity_write_forbidden", "management_identity_not_found", "management_identity_target_changed", "management_identity_write_failed", "management_identity_submission_unknown", "management_email_verification_not_configured"}, code) {
			code = "management_identity_write_failed"
			switch response.StatusCode {
			case 403:
				code = "management_identity_write_forbidden"
			case 401:
				code = "management_identity_client_unavailable"
			case 404:
				code = "management_identity_not_found"
			}
		}
		return Object{"state": "failed", "code": code}, nil
	}
	return Object{"state": "unknown", "code": "management_identity_response_invalid"}, nil
}
func regexpEmailUUID(s string) bool {
	return s == strings.ToLower(s) && uuidPattern.MatchString(s) && len(s) == 36 && s != "00000000-0000-0000-0000-000000000000" && s != "ffffffff-ffff-ffff-ffff-ffffffffffff"
}
