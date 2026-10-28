package publicfetch

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// A2ARejected identifies the original public endpoint rejection. No response
// credential, cookie or private response body is retained.
type A2ARejected struct{ Status int }

func (e *A2ARejected) Error() string { return "public A2A endpoint rejected request" }

func validA2ARead(raw []byte) bool {
	var body map[string]json.RawMessage
	if len(raw) > 32768 || !utf8.Valid(raw) || json.Unmarshal(raw, &body) != nil || len(body) != 4 {
		return false
	}
	var version, method string
	var id int64
	var params map[string]json.RawMessage
	if json.Unmarshal(body["jsonrpc"], &version) != nil || version != "2.0" || json.Unmarshal(body["method"], &method) != nil || method != "GetTask" || json.Unmarshal(body["id"], &id) != nil || id < 1 || id > 9007199254740991 || json.Unmarshal(body["params"], &params) != nil || len(params) != 3 {
		return false
	}
	var task, tenant string
	var history int
	if json.Unmarshal(params["id"], &task) != nil || json.Unmarshal(params["tenant"], &tenant) != nil || json.Unmarshal(params["historyLength"], &history) != nil || history != 0 || len([]rune(tenant)) > 256 {
		return false
	}
	_, e := uuid.Parse(task)
	return e == nil
}

// PostA2A is exclusively the existing unauthenticated, fresh-ID GetTask probe.
// There is no general POST surface or credential argument. DNS is checked once
// and the TLS socket is pinned without consulting proxy environment variables.
func PostA2A(ctx context.Context, address string, body []byte, maxBytes int, timeout time.Duration) ([]byte, error) {
	if !ValidURL(address) || !validA2ARead(body) || maxBytes < 1 || maxBytes > 1048576 || timeout < time.Millisecond || timeout > 30*time.Second {
		return nil, errors.New("invalid public A2A read")
	}
	return publicA2A(ctx, address, body, maxBytes, timeout)
}

// GetA2ACard retains the same rejected-endpoint classification for the card
// stage of that probe. Ordinary Get and its existing consumers are unchanged.
func GetA2ACard(ctx context.Context, address string, maxBytes int, timeout time.Duration) ([]byte, error) {
	if !ValidURL(address) || maxBytes < 1 || maxBytes > 1048576 || timeout < time.Millisecond || timeout > 30*time.Second {
		return nil, errors.New("invalid public card read")
	}
	return publicA2A(ctx, address, nil, maxBytes, timeout)
}
func publicA2A(ctx context.Context, address string, body []byte, maxBytes int, timeout time.Duration) ([]byte, error) {
	return publicScopedJSON(ctx, address, body, maxBytes, timeout, true)
}
func publicScopedJSON(ctx context.Context, address string, body []byte, maxBytes int, timeout time.Duration, a2a bool) ([]byte, error) {
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
	transport := &http.Transport{DisableCompression: true, DisableKeepAlives: true, TLSClientConfig: &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", pinned)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	method := "POST"
	if body == nil {
		method = "GET"
	}
	request, e := http.NewRequestWithContext(ctx, method, address, bytes.NewReader(body))
	if e != nil {
		return nil, e
	}
	request.GetBody = nil
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", "Galaxy-Official/0.1")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
		if a2a {
			request.Header.Set("A2A-Version", "1.0")
		}
	}
	response, e := client.Do(request)
	if e != nil {
		return nil, e
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return nil, &A2ARejected{response.StatusCode}
	}
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
