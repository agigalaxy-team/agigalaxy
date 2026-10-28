package httpboundary

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

type window struct{ until, count int64 }
type categoryState struct {
	counters  map[string]window
	nextSweep int64
}
type Quotas struct {
	policy QuotaPolicy
	now    func() int64
	mu     sync.Mutex
	states map[string]*categoryState
}

func NewQuotas(policy QuotaPolicy, now func() int64) (*Quotas, error) {
	if e := policy.Validate(); e != nil {
		return nil, e
	}
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	return &Quotas{policy: policy, now: now, states: map[string]*categoryState{}}, nil
}
func (q *Quotas) PolicyHash() string {
	raw, _ := protocol.Encode(q.policy)
	return identity.Digest(raw)
}

type dimension struct{ name, id string }

func (q *Quotas) consume(category string, ids []dimension, w http.ResponseWriter) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	state := q.states[category]
	if state == nil {
		state = &categoryState{counters: map[string]window{}}
		q.states[category] = state
	}
	at := q.now()
	if at >= state.nextSweep {
		for key, v := range state.counters {
			if v.until <= at {
				delete(state.counters, key)
			}
		}
		state.nextSweep = at + 1000
	}
	type selected struct {
		key, name string
		value     window
	}
	items := []selected{}
	newKeys := 0
	limits := q.policy.category(category)
	reject := func(d string, until int64, code string, status int) error {
		seconds := (until - at + 999) / 1000
		if seconds < 1 {
			seconds = 1
		}
		w.Header().Set("Retry-After", strconv.FormatInt(seconds, 10))
		w.Header().Set("X-Galaxy-Quota-Category", category)
		w.Header().Set("X-Galaxy-Quota-Dimension", d)
		return fault.New(code, status)
	}
	for _, d := range ids {
		key := d.name + ":" + d.id
		prior, exists := state.counters[key]
		value := prior
		if !exists || value.until <= at {
			value = window{until: at + q.policy.WindowMs}
		}
		limit := limits.Credential
		if d.name == "ip" {
			limit = limits.IP
		} else if d.name == "subject" {
			limit = limits.Subject
		}
		if value.count >= limit {
			return reject(d.name, value.until, "rate_limited", 429)
		}
		if !exists {
			newKeys++
		}
		items = append(items, selected{key, d.name, value})
	}
	if len(state.counters)+newKeys > q.policy.CapacityPerCategory {
		return reject("capacity", at+1000, "capacity_limited", 503)
	}
	for _, item := range items {
		item.value.count++
		state.counters[item.key] = item.value
	}
	return nil
}
func (q *Quotas) Begin(method, path, address string, credential bool, w http.ResponseWriter) (func(string, string) error, error) {
	category := Category(method, path, credential, false)
	if e := q.consume(category, []dimension{{"ip", address}}, w); e != nil {
		return nil, e
	}
	return func(subject, token string) error {
		if !subjectPattern.MatchString(subject) {
			return errors.New("quota_authentication_context_unavailable")
		}
		return q.consume(category, []dimension{{"subject", subject}, {"credential", identity.Digest([]byte(token))}}, w)
	}, nil
}
func (q *Quotas) BeginWebsite(r *http.Request, path, address, token string, w http.ResponseWriter, read func(*http.Request) (string, int64, error)) error {
	if !opaquePattern.MatchString(token) || read == nil {
		return errors.New("website_quota_session_lookup_required")
	}
	category := Category(r.Method, path, true, true)
	if e := q.consume(category, []dimension{{"ip", address}}, w); e != nil {
		return e
	}
	id, expires, e := read(r)
	if e != nil {
		return e
	}
	if !uuidPattern.MatchString(id) || expires <= q.now()/1000 || expires > 9007199254740991 {
		if category != "anonymous" {
			return q.consume("anonymous", []dimension{{"ip", address}}, w)
		}
		return nil
	}
	return q.consume(category, []dimension{{"subject", "account:" + id}, {"credential", identity.Digest([]byte(token))}}, w)
}
func (q *Quotas) BeginVerifiedService(address string, w http.ResponseWriter) error {
	w.Header().Set("X-Galaxy-Quota-Scope", "verified-agentos")
	return q.consume("query", []dimension{{"ip", address}}, w)
}

type FixedWindow struct {
	limit    int64
	capacity int
	now      func() int64
	mu       sync.Mutex
	windows  map[string]window
}

func NewFixedWindow(limit int64, capacity int, now func() int64) (*FixedWindow, error) {
	if limit < 1 || limit > 9007199254740991 {
		return nil, invalidConfig()
	}
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	return &FixedWindow{limit: limit, capacity: capacity, now: now, windows: map[string]window{}}, nil
}
func (l *FixedWindow) Consume(key string, w http.ResponseWriter) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	at := l.now()
	for k, v := range l.windows {
		if v.until <= at {
			delete(l.windows, k)
		}
	}
	v, ok := l.windows[key]
	if !ok {
		if len(l.windows) >= l.capacity {
			return fault.New("capacity_limited", 503)
		}
		v = window{until: at + 60000}
	}
	v.count++
	l.windows[key] = v
	if v.count > l.limit {
		w.Header().Set("Retry-After", "60")
		return fault.New("rate_limited", 429)
	}
	return nil
}

type requestState struct {
	mu           sync.Mutex
	captured     bool
	captureError error
	capture      func(string, string) error
	address      string
	writer       http.ResponseWriter
	search       *FixedWindow
}
type contextKey struct{}

// CaptureAuthenticated consumes the deferred dimensions at most once, only
// after a real credential verifier has established the current subject.
func CaptureAuthenticated(ctx context.Context, subject, credential string) error {
	state, _ := ctx.Value(contextKey{}).(*requestState)
	if state == nil || state.capture == nil {
		return nil
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.captured {
		return state.captureError
	}
	state.captured = true
	state.captureError = state.capture(subject, credential)
	return state.captureError
}
func ConsumeSearchPage(ctx context.Context, after *string, kind, id string) error {
	if after == nil {
		return nil
	}
	state, _ := ctx.Value(contextKey{}).(*requestState)
	if state == nil {
		return nil
	}
	key := "anonymous:" + state.address
	if kind == "account" {
		key = "account:" + id
	} else if kind == "subject" {
		key = "subject:" + id
	}
	if e := state.search.Consume(key, state.writer); e != nil {
		state.writer.Header().Set("X-Galaxy-Quota-Category", "search-pagination")
		return e
	}
	return nil
}

type Boundary struct {
	config                 Config
	addresses              *AddressReader
	quotas, privateQuotas  *Quotas
	legacy, health, search *FixedWindow
}

func New(c Config) (*Boundary, error) {
	if !canonicalOrigin(c.Endpoint) {
		return nil, invalidConfig()
	}
	origins, e := ValidateBrowserOrigins(c.Origins)
	if e != nil {
		return nil, e
	}
	c.Origins = origins
	addresses, e := NewAddressReader(c.TrustedProxyAddresses)
	if e != nil {
		return nil, e
	}
	var quotas *Quotas
	if c.QuotaPolicy != nil {
		copy := *c.QuotaPolicy
		c.QuotaPolicy = &copy
		quotas, e = NewQuotas(copy, c.NowMs)
		if e != nil {
			return nil, e
		}
	}
	privatePolicy := DefaultQuotaPolicy()
	if c.QuotaPolicy != nil {
		privatePolicy = *c.QuotaPolicy
	}
	private, e := NewQuotas(privatePolicy, c.NowMs)
	if e != nil {
		return nil, e
	}
	limit := int64(60)
	if c.LegacyRateLimit != nil {
		limit = *c.LegacyRateLimit
	}
	legacy, e := NewFixedWindow(limit, 10000, nil)
	if e != nil {
		return nil, e
	}
	limit = 120
	if c.HealthRateLimit != nil {
		limit = *c.HealthRateLimit
	}
	health, e := NewFixedWindow(limit, 10000, nil)
	if e != nil {
		return nil, e
	}
	limit = 25
	if c.SearchPageLimit != nil {
		limit = *c.SearchPageLimit
	}
	search, e := NewFixedWindow(limit, 10000, c.NowMs)
	if e != nil {
		return nil, e
	}
	return &Boundary{c, addresses, quotas, private, legacy, health, search}, nil
}

var privatePaths = map[string]bool{"/v1/internal/agentos/authorize": true, "/v1/internal/agentos/tools/execute": true, "/v1/internal/agentos/p13/context": true, "/v1/internal/agentos/p13/step": true, "/v1/internal/agentos/autonomy/authorize": true, "/v1/internal/agentos/autonomy/report": true, "/v1/internal/agentos/autonomy/tools/execute": true, "/v1/internal/agentos/autonomy/code": true}

func (b *Boundary) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := uuid.NewString()
		w.Header().Set("X-Request-Id", id)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		e := b.serve(w, r, next)
		if e == nil {
			return
		}
		status := fault.Status(e)
		if fault.Code(e) == "internal_error" {
			status = 500
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": fault.Code(e), "requestId": id})
	})
}
func (b *Boundary) serve(w http.ResponseWriter, r *http.Request, next http.Handler) error {
	address, e := b.addresses.Read(r)
	if e != nil {
		return e
	}
	u, e := RequestURL(r, b.config.Endpoint, b.config.Origins)
	if e != nil {
		if limited := b.legacy.Consume(address, w); limited != nil {
			return limited
		}
		return e
	}
	copy := r.Clone(r.Context())
	copy.URL = u
	r = copy
	path := u.EscapedPath()
	state := &requestState{address: address, writer: w, search: b.search}
	probe := r.Method == "GET" && (path == "/healthz" || path == "/readyz")
	if probe {
		e = b.health.Consume(address, w)
	} else if r.Method == "POST" && u.RawQuery == "" && privatePaths[path] && b.config.VerifyPrivateService != nil && b.config.VerifyPrivateService(r) == nil {
		e = b.privateQuotas.BeginVerifiedService(address, w)
	} else if b.quotas != nil {
		token := WebsiteQuotaCredential(r, path)
		if b.config.AccountQuotaSession != nil && r.Method != "OPTIONS" && token != "" {
			e = b.quotas.BeginWebsite(r, path, address, token, w, b.config.AccountQuotaSession)
		} else {
			state.capture, e = b.quotas.Begin(r.Method, path, address, HasRequestCredential(r, path), w)
		}
	} else {
		e = b.legacy.Consume(address, w)
	}
	if e != nil {
		return e
	}
	done, e := ApplyBrowserPolicy(r, w, b.config.Origins)
	if e != nil || done {
		return e
	}
	next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, state)))
	return nil
}
