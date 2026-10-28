package servicemetadata

import (
	"encoding/json"
	"io"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type profile struct {
	NetworkType    string `json:"networkType"`
	DisplayName    string `json:"displayName"`
	ServiceVersion string `json:"serviceVersion"`
	Hub            *hub   `json:"hub,omitempty"`
}
type hub struct {
	Profile string `json:"profile"`
	Charter string `json:"charter"`
	Scope   string `json:"scope"`
	Exit    string `json:"exit"`
	Export  string `json:"export"`
}

func loadProfile(path string) (profile, error) {
	p := profile{NetworkType: "official", DisplayName: "Galaxy Official", ServiceVersion: "0.1.0"}
	if path == "" {
		return p, nil
	}
	file, e := os.Open(path)
	if e != nil {
		return p, e
	}
	defer file.Close()
	info, e := file.Stat()
	if e != nil {
		return p, e
	}
	if !info.Mode().IsRegular() || info.Size() > 16384 {
		return p, invalid()
	}
	raw, e := io.ReadAll(io.LimitReader(file, 16385))
	if e != nil {
		return p, e
	}
	if len(raw) > 16384 {
		return p, invalid()
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return p, invalid()
	}
	var kind string
	if json.Unmarshal(fields["networkType"], &kind) != nil {
		return p, invalid()
	}
	allowed := map[string]bool{"networkType": true, "displayName": true, "serviceVersion": true}
	if kind == "hub" {
		allowed["hub"] = true
		p = profile{}
	}
	for name, raw := range fields {
		if !allowed[name] || string(raw) == "null" {
			return p, invalid()
		}
	}
	if protocol.Decode(raw, &p) != nil {
		return p, invalid()
	}
	if kind == "official" && p.Hub != nil || kind != "official" && kind != "hub" {
		return p, invalid()
	}
	if kind == "hub" {
		if _, ok := fields["displayName"]; !ok {
			return p, invalid()
		}
		if _, ok := fields["serviceVersion"]; !ok {
			return p, invalid()
		}
	}
	return p, nil
}

var semver = regexp.MustCompile(`^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)

func text(value string, max int) bool {
	return protocol.TextLength(value) > 0 && protocol.TextLength(value) <= max
}
func validate(c Configuration, p profile) error {
	u, e := url.Parse(c.Endpoint)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return invalid()
	}
	canonicalHost := strings.ToLower(u.Hostname())
	if strings.IndexFunc(canonicalHost, func(r rune) bool { return r > 127 }) >= 0 {
		return invalid()
	}
	if ip, err := netip.ParseAddr(canonicalHost); err == nil {
		canonicalHost = ip.String()
		if ip.Is6() {
			canonicalHost = "[" + canonicalHost + "]"
		}
	} else if ip, numeric, err := browserIPv4(canonicalHost); err != nil {
		return invalid()
	} else if numeric {
		canonicalHost = ip.String()
	}
	if u.Port() != "" && u.Port() != "443" {
		canonicalHost += ":" + u.Port()
	}
	if c.Endpoint != "https://"+canonicalHost {
		return invalid()
	}
	for _, v := range []string{p.DisplayName, c.Operator, c.Region, c.SigningKeyID} {
		if !text(v, 240) {
			return invalid()
		}
	}
	seen := map[string]bool{}
	for _, v := range c.Capabilities {
		if seen[v] || v != "binding" && v != "sessions" && v != "docs-mcp" {
			return invalid()
		}
		seen[v] = true
	}
	if p.NetworkType == "official" {
		if p.ServiceVersion != "0.1.0" || p.Hub != nil {
			return invalid()
		}
		return nil
	}
	if p.NetworkType != "hub" || !text(p.ServiceVersion, 80) || !semver.MatchString(p.ServiceVersion) || !publicURL(c.Endpoint) || p.Hub == nil {
		return invalid()
	}
	h := p.Hub
	if h.Profile != "galaxy-hub/1" || protocol.TextLength(h.Charter) > 500 || !publicURL(h.Charter) {
		return invalid()
	}
	for _, v := range []string{h.Scope, h.Exit, h.Export} {
		if !text(v, 1500) || strings.TrimSpace(v) == "" || strings.IndexFunc(v, func(r rune) bool { return unicode.IsControl(r) }) >= 0 {
			return invalid()
		}
	}
	return nil
}

// Same literal-address policy as original public-fetch; no discovery DNS or
// outbound request is performed while loading operator metadata.
func publicURL(value string) bool {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.RawQuery != "" || u.Port() != "" && u.Port() != "443" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if strings.HasSuffix(host, ".") || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return false
	}
	ip, e := netip.ParseAddr(host)
	if e != nil {
		var numeric bool
		ip, numeric, e = browserIPv4(host)
		if e != nil {
			return false
		}
		if !numeric {
			return true
		}
	}
	if ip.Is4In6() {
		return false
	}
	if !ip.IsGlobalUnicast() {
		return false
	}
	for _, s := range []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "192.175.48.0/24", "192.31.196.0/24", "192.52.193.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "::ffff:0:0:0/96", "fec0::/10", "64:ff9b:1::/48", "2001::/23", "2620:4f:8000::/48", "5f00::/16", "3fff::/20", "100::/64", "64:ff9b::/96", "2001::/32", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8"} {
		if netip.MustParsePrefix(s).Contains(ip) {
			return false
		}
	}
	return true
}

// WHATWG URLs normalize short, decimal, hexadecimal and octal IPv4 forms
// before public-fetch checks their address range.
func browserIPv4(host string) (netip.Addr, bool, error) {
	parts := strings.Split(host, ".")
	number := func(s string) (uint64, error) {
		base := 10
		if strings.HasPrefix(strings.ToLower(s), "0x") {
			base = 16
			s = s[2:]
		} else if len(s) > 1 && s[0] == '0' {
			base = 8
			s = s[1:]
		}
		if s == "" {
			return 0, nil
		}
		return strconv.ParseUint(s, base, 32)
	}
	last := parts[len(parts)-1]
	_, lastErr := number(last)
	numeric := last != "" && (lastErr == nil || strings.IndexFunc(last, func(r rune) bool { return r < '0' || r > '9' }) < 0)
	if !numeric {
		return netip.Addr{}, false, nil
	}
	if len(parts) > 4 {
		return netip.Addr{}, true, invalid()
	}
	var total uint64
	for i, part := range parts {
		n, e := number(part)
		if e != nil || part == "" {
			return netip.Addr{}, true, invalid()
		}
		if i < len(parts)-1 {
			if n > 255 {
				return netip.Addr{}, true, invalid()
			}
			total = total*256 + n
		} else {
			limit := uint64(1) << uint(8*(5-len(parts)))
			if n >= limit {
				return netip.Addr{}, true, invalid()
			}
			total = (total << uint(8*(5-len(parts)))) + n
		}
	}
	return netip.AddrFrom4([4]byte{byte(total >> 24), byte(total >> 16), byte(total >> 8), byte(total)}), true, nil
}
