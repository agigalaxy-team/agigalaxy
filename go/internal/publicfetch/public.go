// Package publicfetch implements the existing read-only public HTTPS gate.
// Domain services choose approved routes and separately verify signed content.
package publicfetch

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

func IsPublicAddress(a netip.Addr) bool {
	if a.Is4In6() || !a.IsGlobalUnicast() || a.IsPrivate() || a.IsLoopback() || a.IsLinkLocalUnicast() {
		return false
	}
	for _, p := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.175.48.0/24", "192.31.196.0/24", "192.52.193.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "2001::/23", "2001:10::/28", "2001:20::/28", "2001:30::/28", "2002::/16", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "fec0::/10", "::ffff:0:0:0/96", "2620:4f:8000::/48", "5f00::/16", "3fff::/20"} {
		if netip.MustParsePrefix(p).Contains(a) {
			return false
		}
	}
	return true
}
func ValidURL(value string) bool {
	u, e := url.Parse(value)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" && u.Port() != "443" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if strings.HasSuffix(host, ".") || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return false
	}
	if a, e := netip.ParseAddr(host); e == nil && !IsPublicAddress(a) {
		return false
	}
	return true
}

// Get returns the valid JSON wire after the original UTF-8 decoder's BOM
// handling. It sends no credentials and has no proxy, redirect or retry path.
func Get(ctx context.Context, address string, maxBytes int, timeout time.Duration) ([]byte, error) {
	if !ValidURL(address) || maxBytes < 1 || maxBytes > 1048576 || timeout < time.Millisecond || timeout > 30*time.Second {
		return nil, errors.New("invalid public request")
	}
	u, _ := url.Parse(address)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	addresses, e := net.DefaultResolver.LookupNetIP(ctx, "ip", u.Hostname())
	if e != nil || len(addresses) == 0 {
		return nil, errors.New("public endpoint unavailable")
	}
	for _, a := range addresses {
		if !IsPublicAddress(a) {
			return nil, errors.New("unsafe public DNS result")
		}
	}
	pinned := net.JoinHostPort(addresses[0].String(), "443")
	transport := &http.Transport{DisableCompression: true, DisableKeepAlives: true, TLSClientConfig: &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, _ string, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", pinned)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, e := http.NewRequestWithContext(ctx, "GET", address, nil)
	if e != nil {
		return nil, e
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Galaxy-Official/0.1")
	if u.Hostname() == "api.github.com" {
		request.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	}
	response, e := client.Do(request)
	if e != nil {
		return nil, e
	}
	defer response.Body.Close()
	media := strings.ToLower(response.Header.Get("Content-Type"))
	if response.StatusCode != 200 || media != "application/json" && !strings.HasPrefix(media, "application/json;") || response.Header.Get("Content-Encoding") != "" {
		return nil, errors.New("invalid public endpoint response")
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, int64(maxBytes)+1))
	if e != nil || len(raw) > maxBytes || !utf8.Valid(raw) {
		return nil, errors.New("invalid public endpoint body")
	}
	raw = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	if !json.Valid(raw) {
		return nil, errors.New("invalid public endpoint JSON")
	}
	return raw, nil
}
