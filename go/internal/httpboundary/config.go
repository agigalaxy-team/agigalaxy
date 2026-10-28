package httpboundary

import (
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type Dimensions struct {
	IP         int64 `json:"ip"`
	Subject    int64 `json:"subject"`
	Credential int64 `json:"credential"`
}
type Categories struct {
	Anonymous     Dimensions `json:"anonymous"`
	Binding       Dimensions `json:"binding"`
	Query         Dimensions `json:"query"`
	Submission    Dimensions `json:"submission"`
	Notifications Dimensions `json:"notifications"`
	Export        Dimensions `json:"export"`
	Revocation    Dimensions `json:"revocation"`
}
type QuotaPolicy struct {
	Version             int        `json:"version"`
	WindowMs            int64      `json:"windowMs"`
	CapacityPerCategory int        `json:"capacityPerCategory"`
	Categories          Categories `json:"categories"`
}

func DefaultQuotaPolicy() QuotaPolicy {
	return QuotaPolicy{1, 60000, 10000, Categories{Dimensions{60, 60, 60}, Dimensions{60, 60, 60}, Dimensions{600, 120, 60}, Dimensions{300, 60, 30}, Dimensions{300, 120, 60}, Dimensions{120, 30, 15}, Dimensions{300, 120, 60}}}
}
func (p QuotaPolicy) category(name string) Dimensions {
	switch name {
	case "anonymous":
		return p.Categories.Anonymous
	case "binding":
		return p.Categories.Binding
	case "query":
		return p.Categories.Query
	case "submission":
		return p.Categories.Submission
	case "notifications":
		return p.Categories.Notifications
	case "export":
		return p.Categories.Export
	default:
		return p.Categories.Revocation
	}
}
func (p QuotaPolicy) Validate() error {
	if p.Version != 1 || p.WindowMs < 1000 || p.WindowMs > 60000 || p.CapacityPerCategory < 3 || p.CapacityPerCategory > 100000 {
		return invalidConfig()
	}
	for _, name := range []string{"anonymous", "binding", "query", "submission", "notifications", "export", "revocation"} {
		d := p.category(name)
		for _, v := range []int64{d.IP, d.Subject, d.Credential} {
			if v < 1 || v > 1000000 {
				return invalidConfig()
			}
		}
	}
	return nil
}
func invalidConfig() error { return fault.New("http_boundary_configuration_invalid", 400) }
func fileJSON(path string, max int64, out any) error {
	if !filepath.IsAbs(path) {
		return invalidConfig()
	}
	before, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !before.Mode().IsRegular() || before.Size() > max {
		return invalidConfig()
	}
	f, e := os.Open(path)
	if e != nil {
		return e
	}
	defer f.Close()
	opened, e := f.Stat()
	if e != nil || !os.SameFile(before, opened) {
		return invalidConfig()
	}
	raw, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil {
		return e
	}
	after, e := f.Stat()
	if e != nil || int64(len(raw)) > max || after.Size() != int64(len(raw)) || !after.ModTime().Equal(opened.ModTime()) {
		return invalidConfig()
	}
	if protocol.Decode(raw, out) != nil {
		return invalidConfig()
	}
	var got, want any
	expected, _ := json.Marshal(out)
	if json.Unmarshal(raw, &got) != nil || json.Unmarshal(expected, &want) != nil || !sameKeys(got, want) {
		return invalidConfig()
	}
	return nil
}
func LoadQuotaPolicy(path string) (*QuotaPolicy, error) {
	if path == "" {
		p := DefaultQuotaPolicy()
		return &p, nil
	}
	var p QuotaPolicy
	if e := fileJSON(path, 8192, &p); e != nil {
		return nil, e
	}
	if e := p.Validate(); e != nil {
		return nil, e
	}
	return &p, nil
}

type BrowserPolicy struct {
	Version int      `json:"version"`
	Origins []string `json:"origins"`
}

func canonicalOrigin(value string) bool {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Port() == "443" || u.Host != strings.ToLower(u.Host) || value != "https://"+u.Host {
		return false
	}
	return true
}
func ValidateBrowserOrigins(origins []string) ([]string, error) {
	if len(origins) > 16 {
		return nil, invalidConfig()
	}
	result := []string{}
	for _, origin := range origins {
		if !canonicalOrigin(origin) {
			return nil, invalidConfig()
		}
		if !has(result, origin) {
			result = append(result, origin)
		}
	}
	return result, nil
}
func LoadBrowserPolicy(path string) (BrowserPolicy, error) {
	if path == "" {
		return BrowserPolicy{1, []string{}}, nil
	}
	var p BrowserPolicy
	if e := fileJSON(path, 4096, &p); e != nil {
		return p, e
	}
	if p.Version != 1 || p.Origins == nil {
		return p, invalidConfig()
	}
	origins, e := ValidateBrowserOrigins(p.Origins)
	p.Origins = origins
	return p, e
}
func has(values []string, v string) bool {
	for _, item := range values {
		if item == v {
			return true
		}
	}
	return false
}
func header(r *http.Request, name string) string {
	values := r.Header.Values(name)
	separator := ", "
	if strings.EqualFold(name, "Cookie") {
		separator = "; "
	}
	return strings.Join(values, separator)
}
func canonicalIP(value string) (string, error) {
	if strings.Contains(value, "%") {
		return "", invalidConfig()
	}
	ip, e := netip.ParseAddr(value)
	if e != nil {
		return "", invalidConfig()
	}
	return ip.Unmap().String(), nil
}

type AddressReader struct{ trusted map[string]bool }

func NewAddressReader(proxies []string) (*AddressReader, error) {
	if len(proxies) > 32 {
		return nil, invalidConfig()
	}
	trusted := map[string]bool{}
	for _, value := range proxies {
		address, e := canonicalIP(value)
		if e != nil {
			return nil, e
		}
		trusted[address] = true
	}
	return &AddressReader{trusted}, nil
}
func (a *AddressReader) Read(r *http.Request) (string, error) {
	raw := r.RemoteAddr
	if host, e := netip.ParseAddrPort(raw); e == nil {
		raw = host.Addr().String()
	} else if host, _, e := strings.Cut(raw, ":"); e && strings.Count(raw, ":") == 1 {
		raw = host
	}
	socket, e := canonicalIP(raw)
	if e != nil {
		return "", e
	}
	if !a.trusted[socket] {
		return socket, nil
	}
	forwarded := header(r, "X-Forwarded-For")
	if forwarded == "" || len(forwarded) > 1024 {
		return "", fault.New("invalid_forwarded_address", 400)
	}
	parts := strings.Split(forwarded, ",")
	if len(parts) > 16 {
		return "", fault.New("invalid_forwarded_address", 400)
	}
	addresses := make([]string, len(parts))
	for i, p := range parts {
		value, e := canonicalIP(strings.TrimSpace(p))
		if e != nil {
			return "", fault.New("invalid_forwarded_address", 400)
		}
		addresses[i] = value
	}
	address := socket
	for i := len(addresses) - 1; i >= 0 && a.trusted[address]; i-- {
		address = addresses[i]
	}
	return address, nil
}

// Config callbacks are fed verified server sessions/service checks. Candidate
// cookies and arbitrary request JSON never establish quota subject authority.
type Config struct {
	Endpoint                                          string
	Origins, TrustedProxyAddresses                    []string
	QuotaPolicy                                       *QuotaPolicy
	NowMs                                             func() int64
	AccountQuotaSession                               func(*http.Request) (string, int64, error)
	VerifyPrivateService                              func(*http.Request) error
	LegacyRateLimit, HealthRateLimit, SearchPageLimit *int64
}
type LoadOptions struct {
	Config
	QuotaFile, BrowserFile string
}

func Load(o LoadOptions) (*Boundary, error) {
	p, e := LoadQuotaPolicy(o.QuotaFile)
	if e != nil {
		return nil, e
	}
	browser, e := LoadBrowserPolicy(o.BrowserFile)
	if e != nil {
		return nil, e
	}
	o.Config.QuotaPolicy = p
	o.Config.Origins = browser.Origins
	return New(o.Config)
}

var subjectPattern = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var opaquePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func sameKeys(raw, shape any) bool {
	m, object := shape.(map[string]any)
	if !object {
		return true
	}
	actual, ok := raw.(map[string]any)
	if !ok || len(actual) != len(m) {
		return false
	}
	for key, v := range m {
		value, exists := actual[key]
		if !exists || !sameKeys(value, v) {
			return false
		}
	}
	return true
}
