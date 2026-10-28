// Package retirement preserves the existing published retirement policy and
// runtime gates. It neither performs data migration nor physical deletion.
package retirement

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

type Policy struct {
	Version           int    `json:"version"`
	ID                string `json:"id"`
	Endpoint          string `json:"endpoint"`
	Operator          string `json:"operator"`
	Reason            string `json:"reason"`
	AnnouncedAt       int64  `json:"announcedAt"`
	StopWritesAt      int64  `json:"stopWritesAt"`
	TakeoutUntil      int64  `json:"takeoutUntil"`
	StatusUntil       int64  `json:"statusUntil"`
	ContactURL        string `json:"contactUrl"`
	DeletionPolicyURL string `json:"deletionPolicyUrl"`
}
type Options struct {
	Endpoint string
	Now      func() time.Time
}
type Controller struct {
	policy   *Policy
	endpoint string
	now      func() time.Time
}
type Snapshot struct {
	Version                int     `json:"version"`
	Endpoint               string  `json:"endpoint,omitempty"`
	Phase                  string  `json:"phase"`
	CheckedAt              int64   `json:"checkedAt"`
	Policy                 *Policy `json:"policy"`
	BusinessWritesAccepted bool    `json:"businessWritesAccepted"`
	DownloadsAccepted      bool    `json:"downloadsAccepted"`
	Deletion               string  `json:"deletion"`
	Validity               string  `json:"validity"`
	AutomaticMigration     bool    `json:"automaticMigration"`
}
type SQLReader interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

var policyID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)

func invalid() error { return fault.New("retirement_policy_invalid", 400) }
func publicURL(value string, origin bool) bool {
	u, e := url.Parse(value)
	if e != nil || !strings.EqualFold(u.Scheme, "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	if origin {
		if u.Scheme != "https" || u.Path != "" || u.Port() == "443" || u.Host != strings.ToLower(u.Host) || u.String() != value || value != "https://"+u.Host {
			return false
		}
		for _, c := range u.Host {
			if c > 127 || c == '%' {
				return false
			}
		}
	}
	return true
}
func (p Policy) Validate() error {
	if p.Version != 1 || !policyID.MatchString(p.ID) || !publicURL(p.Endpoint, true) || protocol.TextLength(p.Operator) < 1 || protocol.TextLength(p.Operator) > 200 || protocol.TextLength(p.Reason) < 1 || protocol.TextLength(p.Reason) > 2000 || !publicURL(p.ContactURL, false) || !publicURL(p.DeletionPolicyURL, false) {
		return invalid()
	}
	for _, v := range []int64{p.AnnouncedAt, p.StopWritesAt, p.TakeoutUntil, p.StatusUntil} {
		if v < 0 || v > 9007199254740991 {
			return invalid()
		}
	}
	if p.AnnouncedAt > p.StopWritesAt || p.StopWritesAt >= p.TakeoutUntil || p.TakeoutUntil >= p.StatusUntil {
		return invalid()
	}
	return nil
}
func New(input *Policy, o Options) (*Controller, error) {
	if input != nil {
		if e := input.Validate(); e != nil {
			return nil, e
		}
		if o.Endpoint != "" && o.Endpoint != input.Endpoint {
			return nil, invalid()
		}
		copy := *input
		input = &copy
	}
	endpoint := o.Endpoint
	if endpoint == "" && input != nil {
		endpoint = input.Endpoint
	}
	return &Controller{input, endpoint, o.Now}, nil
}

// Load reads GALAXY_RETIREMENT_FILE when configured; an empty path retains the
// original normal controller. No policy file or operational state is written.
func Load(path string, o Options) (*Controller, error) {
	if path == "" {
		return New(nil, o)
	}
	if !filepath.IsAbs(path) {
		return nil, invalid()
	}
	before, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !before.Mode().IsRegular() || before.Size() > 16384 {
		return nil, invalid()
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !os.SameFile(before, opened) {
		return nil, invalid()
	}
	raw, e := io.ReadAll(io.LimitReader(f, 16385))
	if e != nil {
		return nil, e
	}
	after, e := f.Stat()
	if e != nil || len(raw) > 16384 || after.Size() != int64(len(raw)) || !after.ModTime().Equal(opened.ModTime()) {
		return nil, invalid()
	}
	var p Policy
	var m map[string]json.RawMessage
	if protocol.Decode(raw, &p) != nil || json.Unmarshal(raw, &m) != nil || len(m) != 11 {
		return nil, invalid()
	}
	for _, key := range []string{"version", "id", "endpoint", "operator", "reason", "announcedAt", "stopWritesAt", "takeoutUntil", "statusUntil", "contactUrl", "deletionPolicyUrl"} {
		v, ok := m[key]
		if !ok || string(v) == "null" {
			return nil, invalid()
		}
	}
	return New(&p, o)
}
func (c *Controller) stamp() int64 {
	if c.now != nil {
		return c.now().Unix()
	}
	return time.Now().Unix()
}
func (c *Controller) Phase() string {
	p := c.policy
	now := c.stamp()
	if p == nil || now < p.AnnouncedAt {
		return "normal"
	}
	if now < p.StopWritesAt {
		return "announced"
	}
	if now < p.TakeoutUntil {
		return "takeout"
	}
	if now < p.StatusUntil {
		return "status-only"
	}
	return "closed"
}
func (c *Controller) CanProcessEvidence() bool {
	phase := c.Phase()
	return phase == "normal" || phase == "announced"
}
func (c *Controller) Snapshot() Snapshot {
	phase := c.Phase()
	var policy *Policy
	if c.policy != nil {
		copy := *c.policy
		policy = &copy
	}
	return Snapshot{1, c.endpoint, phase, c.stamp(), policy, c.CanProcessEvidence(), phase == "normal" || phase == "announced" || phase == "takeout", "revocation is not physical deletion; follow the published deletion policy", "an unavailable status is not proof of validity or deletion", false}
}
func (c *Controller) AssertDownload() error {
	if phase := c.Phase(); phase == "status-only" || phase == "closed" {
		return fault.New("service_takeout_closed", 410)
	}
	return nil
}
func (c *Controller) DownloadDeadline() float64 {
	if c.policy == nil {
		return math.Inf(1)
	}
	return float64(c.policy.TakeoutUntil)
}
func (c *Controller) AssertRoute(method, path string) error {
	phase := c.Phase()
	if phase == "normal" || phase == "announced" || retirementMetadata[method+" "+path] {
		return nil
	}
	if phase == "status-only" && (method == "GET" && retirementProofStatus.MatchString(path) || method == "POST" && (path == "/v2/choice-snapshots/receipt" || path == "/v2/receipt-status/challenges" || path == "/v2/receipt-status/query")) {
		return nil
	}
	if phase == "takeout" && ServiceAccessV2(method, path) != "" {
		return nil
	}
	if phase == "takeout" && (method == "GET" && (path == "/.well-known/galaxy-network.json" || path == "/v1/consents" || retirementTakeoutRead.MatchString(path)) || method == "POST" && (retirementTakeoutPosts[path] || retirementRevocation.MatchString(path) || retirementModerationRead.MatchString(path) || retirementOwnAttachmentExport.MatchString(path))) {
		return nil
	}
	if phase == "takeout" {
		return fault.New("service_writes_stopped", 410)
	}
	return fault.New("service_retired", 410)
}
func (c *Controller) AssertBindingSubject(ctx context.Context, db SQLReader, subject string) error {
	if e := c.AssertDownload(); e != nil {
		return e
	}
	if c.Phase() == "takeout" {
		var exists bool
		if e := db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM subjects WHERE id=$1)", subject).Scan(&exists); e != nil {
			return e
		}
		if !exists {
			return fault.New("service_enrollment_stopped", 410)
		}
	}
	return nil
}

// StatusDeadline clips the original retained receipt challenge lifetime at
// statusUntil. It grants no ordinary session or content-read authority.
func (c *Controller) StatusDeadline() (int64, error) {
	now := c.stamp()
	if c.Phase() == "closed" || c.policy != nil && now >= c.policy.StatusUntil {
		return 0, fault.New("service_retired", 410)
	}
	if c.policy == nil {
		return now + 120, nil
	}
	return min(now+120, c.policy.StatusUntil), nil
}

// BindDevice composes the existing narrow deviceauth gates. It never replaces
// a configured additional consent policy or grants a device/account capability.
func (c *Controller) BindDevice(service *deviceauth.Service) {
	previousBinding := service.BindingGate
	service.BindingGate = func(ctx context.Context, db deviceauth.SQLReader, subject string) error {
		if e := c.AssertBindingSubject(ctx, db, subject); e != nil {
			return e
		}
		if previousBinding != nil {
			return previousBinding(ctx, db, subject)
		}
		return nil
	}
	previousPolicy := service.ConsentPolicy
	service.ConsentPolicy = func(ctx context.Context, intent deviceauth.ConsentIntent, actor deviceauth.Actor) error {
		if e := c.AssertRoute("POST", "/v1/consents"); e != nil {
			return e
		}
		if previousPolicy != nil {
			return previousPolicy(ctx, intent, actor)
		}
		return nil
	}
	previousDeadline := service.ReceiptStatusDeadline
	service.ReceiptStatusDeadline = func() (int64, error) {
		deadline, e := c.StatusDeadline()
		if e != nil {
			return 0, e
		}
		if previousDeadline != nil {
			other, e := previousDeadline()
			if e != nil {
				return 0, e
			}
			deadline = min(deadline, other)
		}
		return deadline, nil
	}
}
