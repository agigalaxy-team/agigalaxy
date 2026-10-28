// Package incident preserves the startup-configured incident gates. It provides
// no public incident mutation endpoint or automatic recovery timer.
package incident

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/retirement"
	"github.com/jackc/pgx/v5"
)

type Recovery struct {
	CheckedAt      int64  `json:"checkedAt"`
	EvidenceSHA256 string `json:"evidenceSha256"`
}
type Policy struct {
	Version       int       `json:"version"`
	ID            string    `json:"id"`
	Revision      int64     `json:"revision"`
	Endpoint      string    `json:"endpoint"`
	State         string    `json:"state"`
	UpdatedAt     int64     `json:"updatedAt"`
	PublicMessage string    `json:"publicMessage"`
	Recovery      *Recovery `json:"recovery"`
}
type Options struct {
	Endpoint string
	Now      func() time.Time
}
type Controller struct {
	policy *Policy
	now    func() time.Time
}
type Snapshot struct {
	Version                int     `json:"version"`
	ID                     *string `json:"id"`
	Revision               *int64  `json:"revision"`
	State                  string  `json:"state"`
	UpdatedAt              *int64  `json:"updatedAt"`
	PublicMessage          *string `json:"publicMessage"`
	BusinessWritesAccepted bool    `json:"businessWritesAccepted"`
	SharingAccepted        bool    `json:"sharingAccepted"`
	NotificationDelivery   string  `json:"notificationDelivery"`
	CheckedAt              int64   `json:"checkedAt"`
}

var ref = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var digest = regexp.MustCompile(`^[a-f0-9]{64}$`)

// ECMAScript String.trim includes BOM and excludes Unicode NEL.
func trim(s string) string {
	return strings.Trim(s, "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}

// JSON numbers have JavaScript's numeric semantics, including integral exponent
// notation; all policy counters remain within the source safe-integer range.
func normalizeNumber(m map[string]json.RawMessage, key string) error {
	raw, ok := m[key]
	raw = json.RawMessage(strings.TrimSpace(string(raw)))
	if !ok {
		return invalid()
	}
	var number json.Number
	if protocol.Decode(raw, &number) != nil || len(raw) == 0 || raw[0] == '"' {
		return invalid()
	}
	n, e := strconv.ParseFloat(number.String(), 64)
	if e != nil || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < 0 || n > 9007199254740991 {
		return invalid()
	}
	m[key] = json.RawMessage(strconv.FormatInt(int64(n), 10))
	return nil
}
func invalid() error    { return errors.New("Invalid incident policy") }
func safe(n int64) bool { return n >= 0 && n <= 9007199254740991 }
func (p Policy) Validate() error {
	u, e := url.Parse(p.Endpoint)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || p.Endpoint != "https://"+u.Host || u.Host != strings.ToLower(u.Host) || u.Port() == "443" {
		return invalid()
	}
	for _, c := range u.Host {
		if c > 127 || c == '%' {
			return invalid()
		}
	}
	message := trim(p.PublicMessage)
	if p.Version != 1 || !ref.MatchString(p.ID) || p.Revision < 1 || !safe(p.Revision) || !safe(p.UpdatedAt) || protocol.TextLength(message) < 1 || protocol.TextLength(message) > 1200 {
		return invalid()
	}
	if p.State != "contained" && p.State != "recovery" && p.State != "resolved" {
		return invalid()
	}
	if p.Recovery != nil && (!safe(p.Recovery.CheckedAt) || !digest.MatchString(p.Recovery.EvidenceSHA256)) {
		return invalid()
	}
	if p.State == "resolved" && (p.Recovery == nil || p.Recovery.CheckedAt > p.UpdatedAt) {
		return invalid()
	}
	return nil
}
func clone(p *Policy) *Policy {
	if p == nil {
		return nil
	}
	c := *p
	if p.Recovery != nil {
		r := *p.Recovery
		c.Recovery = &r
	}
	return &c
}
func New(p *Policy, o Options) (*Controller, error) {
	c := &Controller{clone(p), o.Now}
	if p != nil {
		if e := p.Validate(); e != nil {
			return nil, e
		}
		if p.Endpoint != o.Endpoint || p.UpdatedAt > c.stamp() {
			return nil, errors.New("Incident endpoint or time mismatch")
		}
		c.policy.PublicMessage = trim(c.policy.PublicMessage)
	}
	return c, nil
}
func (c *Controller) stamp() int64 {
	if c.now != nil {
		return c.now().Unix()
	}
	return time.Now().Unix()
}
func (c *Controller) Policy() *Policy { return clone(c.policy) }
func (c *Controller) CanProcessEvidence() bool {
	return c.policy == nil || c.policy.State == "resolved"
}
func (c *Controller) Snapshot() Snapshot {
	p := c.Policy()
	s := Snapshot{Version: 1, State: "normal", BusinessWritesAccepted: c.CanProcessEvidence(), SharingAccepted: c.CanProcessEvidence(), NotificationDelivery: "public-status-pull", CheckedAt: c.stamp()}
	if p != nil {
		s.ID = &p.ID
		s.Revision = &p.Revision
		s.State = p.State
		s.UpdatedAt = &p.UpdatedAt
		s.PublicMessage = &p.PublicMessage
	}
	return s
}

// Load consumes GALAXY_INCIDENT_FILE. The original policy is unsigned startup
// configuration; operational authorization/history remain separate consumers.
func Load(path string, o Options) (*Controller, error) {
	if path == "" {
		return New(nil, o)
	}
	if !filepath.IsAbs(path) {
		return nil, errors.New("Incident file must be absolute")
	}
	info, e := os.Stat(path)
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Size() > 16384 {
		return nil, errors.New("Invalid incident file")
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	raw, e := io.ReadAll(io.LimitReader(f, 16385))
	if e != nil {
		return nil, e
	}
	if len(raw) > 16384 {
		return nil, errors.New("Invalid incident file")
	}
	var p Policy
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return nil, invalid()
	}
	required := []string{"version", "id", "revision", "endpoint", "state", "updatedAt", "publicMessage"}
	if len(m) != 7 && len(m) != 8 {
		return nil, invalid()
	}
	for _, k := range required {
		v, ok := m[k]
		if !ok || string(v) == "null" {
			return nil, invalid()
		}
	}
	if len(m) == 8 {
		v, ok := m["recovery"]
		if !ok {
			return nil, invalid()
		}
		if string(v) != "null" {
			var r map[string]json.RawMessage
			if json.Unmarshal(v, &r) != nil || len(r) != 2 || r["checkedAt"] == nil || r["evidenceSha256"] == nil || string(r["checkedAt"]) == "null" || string(r["evidenceSha256"]) == "null" {
				return nil, invalid()
			}
		}
	}
	for _, key := range []string{"version", "revision", "updatedAt"} {
		if normalizeNumber(m, key) != nil {
			return nil, invalid()
		}
	}
	if v, ok := m["recovery"]; ok && string(v) != "null" {
		var r map[string]json.RawMessage
		json.Unmarshal(v, &r)
		if normalizeNumber(r, "checkedAt") != nil {
			return nil, invalid()
		}
		m["recovery"], _ = json.Marshal(r)
	}
	normalized, _ := json.Marshal(m)
	if protocol.Decode(normalized, &p) != nil {
		return nil, invalid()
	}
	return New(&p, o)
}

var publicReads = set("/v1/service-status", "/v1/policy", "/.well-known/galaxy-signing-keys.json", "/v1/signing-keys/status")
var responsePosts = set("/v1/identity/query", "/v1/identity/cancel", "/v1/identity/revoke", "/v1/session-challenges", "/v1/sessions", "/v1/bindings/query", "/v1/data-exports/revoke", "/v1/audit/grants/revoke", "/v2/chat/attachments/revoke", "/v1/notifications/query", "/v1/notifications/read", "/v1/notifications/preferences/read", "/v1/notifications/preferences/save", "/v1/deletion-requests/config", "/v1/deletion-requests/submit", "/v1/deletion-requests/status")
var revoke = regexp.MustCompile(`^/v1/(?:bindings|consents|proofs|context-grants)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/revoke$`)

func set(paths ...string) map[string]bool {
	m := map[string]bool{}
	for _, p := range paths {
		m[p] = true
	}
	return m
}
func (c *Controller) AssertRoute(method, path string) error {
	access := retirement.ServiceAccessV2(method, path)
	if access == "control" || access == "stop" || c.CanProcessEvidence() || method == "GET" && publicReads[path] || method == "POST" && (responsePosts[path] || revoke.MatchString(path)) {
		return nil
	}
	return fault.New("service_incident_contained", 503)
}

type SQLReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (c *Controller) AssertBindingSubject(ctx context.Context, db SQLReader, subject string) error {
	if c.CanProcessEvidence() {
		return nil
	}
	var one int
	e := db.QueryRow(ctx, "SELECT 1 FROM subjects WHERE id=$1", subject).Scan(&one)
	if errors.Is(e, pgx.ErrNoRows) {
		return fault.New("service_enrollment_stopped", 503)
	}
	return e
}
func (c *Controller) BindDevice(s *deviceauth.Service) {
	previous := s.BindingGate
	s.BindingGate = func(ctx context.Context, db deviceauth.SQLReader, subject string) error {
		if e := c.AssertBindingSubject(ctx, db, subject); e != nil {
			return e
		}
		if previous != nil {
			return previous(ctx, db, subject)
		}
		return nil
	}
	policy := s.ConsentPolicy
	s.ConsentPolicy = func(ctx context.Context, intent deviceauth.ConsentIntent, actor deviceauth.Actor) error {
		if e := c.AssertRoute("POST", "/v1/consents"); e != nil {
			return e
		}
		if policy != nil {
			return policy(ctx, intent, actor)
		}
		return nil
	}
}

// Transition is the summary persisted in the original append-only runtime
// configuration snapshot, not the full policy or a command to mutate it.
type Transition struct {
	ID        string `json:"id"`
	Revision  int64  `json:"revision"`
	State     string `json:"state"`
	UpdatedAt int64  `json:"updatedAt"`
	SHA256    string `json:"sha256"`
}

func AssertTransition(previous, next *Transition) error {
	if previous == nil {
		if next != nil && next.State == "resolved" {
			return errors.New("Incident recovery history missing")
		}
		return nil
	}
	if next == nil {
		if previous.State != "resolved" {
			return errors.New("Active incident cannot be removed")
		}
		return nil
	}
	if previous.ID != next.ID {
		if previous.State != "resolved" || next.State == "resolved" {
			return errors.New("Active incident cannot be replaced")
		}
		return nil
	}
	if next.Revision == previous.Revision && next.SHA256 == previous.SHA256 {
		return nil
	}
	if next.Revision != previous.Revision+1 || next.UpdatedAt < previous.UpdatedAt {
		return errors.New("Incident revision conflict")
	}
	return nil
}
