package native

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type ConnectionOptions struct {
	HTTPClient *http.Client
	Now        func() time.Time
}
type ConnectionSnapshot struct {
	BindingID  string         `json:"bindingId"`
	ExpiresAt  int64          `json:"expiresAt"`
	Scopes     []string       `json:"scopes"`
	SubjectID  string         `json:"subjectId"`
	Endpoint   string         `json:"endpoint"`
	Control    map[string]any `json:"control"`
	Generation int64          `json:"generation"`
}
type Connection struct {
	store       *Store
	config      Configuration
	http        *http.Client
	now         func() time.Time
	mu          sync.Mutex
	restoreMu   sync.Mutex
	closed      bool
	fingerprint string
	generation  int64
	session     *connectionSession
}
type connectionSession struct {
	snapshot   ConnectionSnapshot
	credential string
}
type connectionActive struct {
	SubjectID      string         `json:"subjectId"`
	DeviceID       string         `json:"deviceId"`
	InstallationID string         `json:"installationId"`
	GenesisProof   map[string]any `json:"genesisProof"`
}
type connectionPermission struct {
	Enabled   bool     `json:"enabled"`
	SubjectID string   `json:"subjectId"`
	DeviceID  string   `json:"deviceId"`
	Scopes    []string `json:"scopes"`
}
type connectionSelection struct {
	Version     int                   `json:"version"`
	Revision    int64                 `json:"revision"`
	Active      *connectionActive     `json:"active"`
	Permission  *connectionPermission `json:"permission"`
	fingerprint string
}
type connectionLease struct {
	selection      connectionSelection
	generation     int64
	bindingID      string
	requireSession bool
	requireTrust   bool
}

func NewConnection(store *Store, configuration Configuration, options ConnectionOptions) (*Connection, error) {
	u, e := url.Parse(configuration.Endpoint)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.String() != configuration.Endpoint || len(configuration.TrustedKeys) == 0 && len(configuration.RootPins) == 0 || store == nil || store.Endpoint != configuration.Endpoint || filepath.Clean(configuration.DataDirectory) != store.Directory {
		return nil, fault.New("native_connection_configuration_invalid", 400)
	}
	if u.Port() == "443" || u.Host != strings.ToLower(u.Host) {
		return nil, fault.New("native_connection_configuration_invalid", 400)
	}
	if (len(configuration.RootPins) > 0) != (configuration.TrustDirectory != "") || configuration.TrustDirectory != "" && !filepath.IsAbs(configuration.TrustDirectory) || configuration.NetworkType != "" && configuration.NetworkType != "official" && configuration.NetworkType != "hub" {
		return nil, fault.New("native_connection_configuration_invalid", 400)
	}
	pins := make(map[string]Pin, len(configuration.TrustedKeys))
	if len(configuration.RootPins) == 0 {
		for k, pin := range configuration.TrustedKeys {
			if pin.TrustedUntil != nil {
				value := *pin.TrustedUntil
				pin.TrustedUntil = &value
			}
			pins[k] = pin
		}
	}
	configuration.TrustedKeys = pins
	client := http.Client{Timeout: 30 * time.Second}
	if options.HTTPClient != nil {
		client = *options.HTTPClient
	}
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if client.Timeout <= 0 || client.Timeout > 30*time.Second {
		client.Timeout = 30 * time.Second
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Connection{store: store, config: configuration, http: &client, now: now}, nil
}
func connectionRecordPath(dir, key string) string {
	return filepath.Join(dir, "native-v2", "records", identity.Digest([]byte(key))+".json")
}
func (c *Connection) selectionWithin(dir string) (connectionSelection, error) {
	var s connectionSelection
	if _, e := c.store.ownerWithin(dir, ""); e != nil {
		return s, e
	}
	var record map[string]any
	ok, e := readJSON(connectionRecordPath(dir, "native-selection:"+c.config.Endpoint), &record)
	if e != nil {
		return s, e
	}
	if ok {
		if integer(record["version"]) != 1 || integer(record["revision"]) < 1 || !connectionSafeInteger(record["revision"]) {
			return s, connectionFailure("native_selection_invalid")
		}
		if _, ok = record["active"]; !ok {
			return s, connectionFailure("native_selection_invalid")
		}
		if _, ok = record["permission"]; !ok {
			return s, connectionFailure("native_selection_invalid")
		}
	} else {
		record = map[string]any{"version": 1, "revision": 0, "active": nil, "permission": nil}
		for part, key := range map[string]string{"active": "native-active:", "permission": "native-connection:"} {
			var v any
			if _, e = readJSON(connectionRecordPath(dir, key+c.config.Endpoint), &v); e != nil {
				return s, e
			}
			record[part] = v
		}
	}
	raw, e := protocol.Encode(record)
	if e != nil {
		return s, e
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if e = decoder.Decode(&s); e != nil {
		return s, connectionFailure("native_selection_invalid")
	}
	s.fingerprint = identity.Digest(raw)
	return s, nil
}
func (c *Connection) selection(ctx context.Context) (connectionSelection, error) {
	var s connectionSelection
	e := c.store.With(ctx, false, func(dir string) error { var e error; s, e = c.selectionWithin(dir); return e })
	if e != nil {
		return s, e
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return s, connectionFailure("native_runtime_closed")
	}
	if c.fingerprint != "" && c.fingerprint != s.fingerprint {
		c.session = nil
		c.generation++
	}
	c.fingerprint = s.fingerprint
	return s, nil
}
func (c *Connection) lease(ctx context.Context, requireSession bool) (connectionLease, error) {
	selected, e := c.selection(ctx)
	if e != nil {
		return connectionLease{}, e
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.fingerprint != selected.fingerprint {
		return connectionLease{}, connectionFailure("native_connection_selection_changed")
	}
	if requireSession && !c.discoveryTrustCurrentLocked() {
		c.session = nil
		return connectionLease{}, connectionFailure("native_server_pin_invalid")
	}
	if c.session != nil && c.session.snapshot.ExpiresAt <= c.now().Unix() {
		c.session = nil
	}
	lease := connectionLease{selection: selected, generation: c.generation, requireSession: requireSession}
	if c.session != nil {
		lease.bindingID = c.session.snapshot.BindingID
	}
	if requireSession && c.session == nil {
		return lease, connectionFailure("connection_required")
	}
	return lease, nil
}
func (c *Connection) check(ctx context.Context, lease connectionLease) error {
	selected, e := c.selection(ctx)
	if e != nil {
		return e
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || selected.fingerprint != lease.selection.fingerprint || c.generation != lease.generation {
		return connectionFailure("native_connection_selection_changed")
	}
	if lease.requireTrust && !c.discoveryTrustCurrentLocked() {
		return connectionFailure("native_server_pin_invalid")
	}
	if lease.requireSession && (!c.discoveryTrustCurrentLocked() || c.session == nil || c.session.snapshot.BindingID != lease.bindingID || c.session.snapshot.ExpiresAt <= c.now().Unix()) {
		return connectionFailure("native_connection_selection_changed")
	}
	return nil
}
func (c *Connection) Snapshot(ctx context.Context) (*ConnectionSnapshot, error) {
	if _, e := c.selection(ctx); e != nil {
		return nil, e
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.session == nil {
		return nil, nil
	}
	if !c.discoveryTrustCurrentLocked() || c.session.snapshot.ExpiresAt <= c.now().Unix() {
		c.session = nil
		return nil, nil
	}
	s := c.session.snapshot
	s.Scopes = append([]string{}, s.Scopes...)
	s.Control = cloneConnectionMap(s.Control)
	return &s, nil
}
func (c *Connection) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.session = nil
	c.generation++
}

// Disconnect invalidates the in-memory browser-protocol session only. A user
// operation disabling the saved choice must separately update its selection
// record; this method does not change that permission.
func (c *Connection) Disconnect() { c.mu.Lock(); defer c.mu.Unlock(); c.session = nil; c.generation++ }
func (c *Connection) deviceKey(ctx context.Context, lease connectionLease) (ed25519.PrivateKey, string, error) {
	var key ed25519.PrivateKey
	var public string
	e := c.store.With(ctx, false, func(dir string) error {
		selected, e := c.selectionWithin(dir)
		if e != nil {
			return e
		}
		if selected.fingerprint != lease.selection.fingerprint {
			return connectionFailure("native_connection_selection_changed")
		}
		active := selected.Active
		if active == nil {
			return connectionFailure("native_identity_required")
		}
		var material map[string]any
		ok, e := readJSON(connectionRecordPath(dir, "device:"+active.SubjectID+":"+active.DeviceID), &material)
		if e != nil {
			return e
		}
		if !ok || text(material["nativeDeviceKey"]) == "" {
			return connectionFailure("native_device_key_unavailable")
		}
		id := text(material["nativeDeviceKey"])
		if !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(id) {
			return connectionFailure("invalid_device_id")
		}
		path := filepath.Join(dir, "native-v2", "keys", id+".pem")
		if material["nativeGenesis"] == true {
			path = filepath.Join(dir, "galaxy-id-private-key.pem")
		}
		f, e := os.Open(path)
		if e != nil {
			return connectionFailure("native_device_key_unavailable")
		}
		defer f.Close()
		raw, e := io.ReadAll(io.LimitReader(f, 4097))
		if e != nil || len(raw) > 4096 {
			return connectionFailure("native_device_key_invalid")
		}
		key, e = identity.PrivatePEM(raw)
		if e != nil {
			return connectionFailure("native_device_key_invalid")
		}
		public, e = identity.PublicPEM(key.Public().(ed25519.PublicKey))
		if e != nil || public != text(material["publicKeyPem"]) {
			return connectionFailure("native_device_key_mismatch")
		}
		return nil
	})
	return key, public, e
}
func (c *Connection) sign(ctx context.Context, lease connectionLease, payload, kind string) (string, error) {
	if e := c.check(ctx, lease); e != nil {
		return "", e
	}
	key, _, e := c.deviceKey(ctx, lease)
	if e != nil {
		return "", e
	}
	signed, e := identity.SignIdentityPayload(key, payload, kind)
	if e != nil {
		return "", e
	}
	if e = c.check(ctx, lease); e != nil {
		return "", e
	}
	return signed, nil
}

type ConnectionCallOptions struct {
	Method          string
	Unauthenticated bool
	AccountID       string
	LocalUpload     ConnectionLocalUpload
	ExpectedScope   *ChoiceScope
	// ResponseJSON is published only after this request's selected authority
	// has been rechecked. Consumers may retain JSON.parse insertion order for
	// existing source fingerprints; failed requests never publish a body.
	ResponseJSON *json.RawMessage
}
type ConnectionHTTPError struct {
	Code              string
	Status            int
	Outcome           string
	RetryAfterSeconds int64
	RetryAt           string
	Quota             map[string]any
}
type ConnectionRequestError struct{ Code, Outcome string }

func (e *ConnectionRequestError) Error() string { return e.Code }
func (e *ConnectionRequestError) Unwrap() error { return fault.New(e.Code, 503) }
func connectionUnknown(code string) error {
	return &ConnectionRequestError{Code: code, Outcome: "unknown"}
}

func (e *ConnectionHTTPError) Error() string { return e.Code }
func (e *ConnectionHTTPError) Unwrap() error { return fault.New(e.Code, e.Status) }

var connectionErrorCode = regexp.MustCompile(`^[a-z0-9_:-]{1,100}$`)
var connectionReadQuery = regexp.MustCompile(`^/v2/recruitment/[0-9a-f-]{36}/receipt\?operationId=[0-9a-f-]{36}&payloadHash=[a-f0-9]{64}$`)
var connectionQuotaQuery = regexp.MustCompile(`(?i)^/v2/community/quotas\?(?:postId|replyId|sectionId)=[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)

func connectionAllowedQuery(path, method string) bool {
	if !strings.Contains(path, "?") {
		return true
	}
	if method != "GET" {
		return false
	}
	if connectionReadQuery.MatchString(path) || connectionQuotaQuery.MatchString(path) {
		return true
	}
	return connectionPublicAccountQuery(path)
}
func (c *Connection) send(ctx context.Context, path string, input any, method, credential, accountID string, max int64, capture ...*json.RawMessage) (map[string]any, error) {
	if method == "" {
		method = "POST"
	}
	if !regexp.MustCompile(`^/(?:v[12]/|\.well-known/)`).MatchString(path) || strings.Contains(path, "#") || !connectionAllowedQuery(path, method) {
		return nil, connectionFailure("native_api_path_invalid")
	}
	target, e := url.Parse(c.config.Endpoint + path)
	if e != nil || target.Scheme != "https" || target.Host == "" || target.User != nil || target.Fragment != "" || target.Scheme+"://"+target.Host != c.config.Endpoint {
		return nil, connectionFailure("native_origin_changed")
	}
	if accountID != "" && !controlUUID(accountID) {
		return nil, connectionFailure("native_account_target_invalid")
	}
	var body io.Reader
	if method != "GET" && input != nil {
		raw, e := protocol.Encode(input)
		if e != nil {
			return nil, e
		}
		body = strings.NewReader(string(raw))
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(ctx, method, target.String(), body)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Cache-Control", "no-store")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if credential != "" {
		req.Header.Set("Authorization", "Bearer "+credential)
		if accountID != "" {
			req.Header.Set("X-Galaxy-Account-ID", accountID)
		}
	}
	response, e := c.http.Do(req)
	if e != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, connectionUnknown("request_timeout")
		}
		if ctx.Err() == context.Canceled {
			return nil, connectionUnknown("request_cancelled")
		}
		return nil, connectionUnknown("native_request_transport_failed")
	}
	defer response.Body.Close()
	if response.ContentLength > max {
		return nil, connectionUnknown("native_api_response_too_large")
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, max+1))
	if e != nil {
		return nil, connectionUnknown("native_api_response_invalid")
	}
	if int64(len(raw)) > max {
		return nil, connectionUnknown("native_api_response_too_large")
	}
	data, e := connectionObject(raw)
	if e != nil {
		return nil, connectionUnknown("native_api_response_invalid")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		code := text(data["error"])
		if !connectionErrorCode.MatchString(code) {
			code = "request_failed"
		}
		if credential != "" && (response.StatusCode == 401 || response.StatusCode == 403) && isOne(code, "unauthorized", "binding_revoked", "invalid_session", "session_expired", "access_denied") {
			c.mu.Lock()
			if c.session != nil && c.session.credential == credential {
				c.session = nil
			}
			c.mu.Unlock()
		}
		rejection := &ConnectionHTTPError{Code: code, Status: response.StatusCode, Outcome: "rejected"}
		if response.StatusCode == 429 || response.StatusCode == 503 || code == "community_restricted" {
			seconds := response.Header.Get("Retry-After")
			if regexp.MustCompile(`^\d{1,9}$`).MatchString(seconds) {
				var n json.Number = json.Number(seconds)
				age, _ := n.Int64()
				if age > 0 && age <= 31536000 {
					rejection.RetryAfterSeconds = age
					rejection.RetryAt = time.Unix(c.now().Unix()+age, 0).UTC().Format(time.RFC3339Nano)
				}
			}
			quota, _ := data["quota"].(map[string]any)
			if isOne(text(quota["category"]), "task", "comment", "invitation") && connectionSafeInteger(quota["used"]) && connectionSafeInteger(quota["limit"]) && connectionSafeInteger(quota["remaining"]) && isOne(text(quota["tier"]), "new", "normal") {
				if reset, e := time.Parse(time.RFC3339Nano, text(quota["resetAt"])); e == nil {
					if policy, ok := quota["policyVersion"].(string); ok && protocol.TextLength(policy) <= 80 {
						rejection.Quota = map[string]any{"category": quota["category"], "used": quota["used"], "limit": quota["limit"], "remaining": quota["remaining"], "resetAt": reset.UTC().Format("2006-01-02T15:04:05.000Z"), "tier": quota["tier"], "policyVersion": policy}
					}
				}
			}
		}
		return nil, rejection
	}
	if len(capture) > 0 && capture[0] != nil {
		*capture[0] = append(json.RawMessage(nil), raw...)
	}
	return data, nil
}
func (c *Connection) Call(ctx context.Context, path string, input any, options ConnectionCallOptions) (map[string]any, error) {
	if options.ResponseJSON != nil {
		*options.ResponseJSON = nil
	}
	method := options.Method
	if method == "" {
		method = "POST"
	}
	if !regexp.MustCompile(`^/(?:v[12]/|\.well-known/)`).MatchString(path) || strings.Contains(path, "#") || !connectionAllowedQuery(path, method) {
		return nil, connectionFailure("native_api_path_invalid")
	}
	initial, e := c.lease(ctx, false)
	if e != nil {
		return nil, e
	}
	if expected := options.ExpectedScope; expected != nil {
		if options.Unauthenticated {
			e = c.store.With(ctx, false, func(dir string) error {
				if e := c.store.verifyChoiceWithin(dir, expected); e != nil {
					return connectionFailure("native_connection_selection_changed")
				}
				selected, e := c.selectionWithin(dir)
				if e != nil {
					return e
				}
				if selected.fingerprint != initial.selection.fingerprint {
					return connectionFailure("native_connection_selection_changed")
				}
				return nil
			})
			if e != nil {
				return nil, e
			}
		} else {
			active := initial.selection.Active
			if active == nil || expected.Owner != active.SubjectID || expected.Endpoint != c.config.Endpoint || expected.DeviceID != active.DeviceID || expected.Revision != initial.selection.Revision {
				return nil, connectionFailure("native_connection_selection_changed")
			}
		}
	}
	if e = c.checkUpload(ctx, path, input, method, initial, options.LocalUpload); e != nil {
		return nil, e
	}
	if !options.Unauthenticated {
		if _, e = c.Restore(ctx); e != nil {
			return nil, e
		}
	}
	lease, e := c.lease(ctx, !options.Unauthenticated)
	if e != nil {
		return nil, e
	}
	if lease.selection.fingerprint != initial.selection.fingerprint {
		return nil, connectionFailure("native_connection_selection_changed")
	}
	credential, account := "", ""
	if !options.Unauthenticated {
		c.mu.Lock()
		if c.session != nil {
			credential = c.session.credential
		}
		c.mu.Unlock()
		account = options.AccountID
	}
	max := int64(1048576)
	if path == "/v2/account-archives/export" {
		max = 2097152
	}
	var responseJSON json.RawMessage
	var capture *json.RawMessage
	if options.ResponseJSON != nil {
		capture = &responseJSON
	}
	result, requestError := c.send(ctx, path, input, method, credential, account, max, capture)
	if requestError != nil {
		lease.requireSession = false
	}
	if e = c.check(ctx, lease); e != nil {
		return nil, e
	}
	if requestError == nil && options.ResponseJSON != nil {
		*options.ResponseJSON = responseJSON
	}
	return result, requestError
}
