package native

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
)

// A2aPost is a trusted host transport injection, never configuration or peer
// input. Production always uses the public-only gate below; tests can supply
// their own isolated peer transport without changing the configured URL.
type A2aPost func(context.Context, string, []byte, string) ([]byte, error)

var a2aCredentialCharacters = regexp.MustCompile(`^[A-Za-z0-9._~+/-]+={0,2}$`)

func a2aCredentialValid(value string) bool {
	base := strings.TrimRight(value, "=")
	return len(base) >= 1 && len(base) <= 4096 && a2aCredentialCharacters.MatchString(value)
}

type a2aPeerError struct{ Reason string }

func (e *a2aPeerError) Error() string { return "A2A peer error: " + e.Reason }
func a2aRPCError(code int64) error {
	reasons := map[int64]string{-32001: "TASK_NOT_FOUND", -32002: "TASK_NOT_CANCELABLE", -32003: "PUSH_NOTIFICATION_NOT_SUPPORTED", -32004: "UNSUPPORTED_OPERATION", -32005: "CONTENT_TYPE_NOT_SUPPORTED", -32006: "INVALID_AGENT_RESPONSE", -32007: "EXTENDED_AGENT_CARD_NOT_CONFIGURED", -32008: "EXTENSION_SUPPORT_REQUIRED", -32009: "VERSION_NOT_SUPPORTED", -32602: "INVALID_PARAMS", -32700: "INVALID_PARAMS", -32600: "INVALID_PARAMS", -32601: "INVALID_PARAMS"}
	reason := reasons[code]
	if reason == "" {
		reason = "INTERNAL_ERROR"
	}
	return &a2aPeerError{reason}
}

func a2aPostPublic(ctx context.Context, address string, body []byte, credential string) ([]byte, error) {
	if !publicfetch.ValidURL(address) || len(body) > 32768 || !json.Valid(body) || credential != "" && !a2aCredentialValid(credential) {
		return nil, a2aError("invalid peer request")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	u, _ := url.Parse(address)
	addresses, e := net.DefaultResolver.LookupNetIP(ctx, "ip", u.Hostname())
	if e != nil || len(addresses) == 0 {
		return nil, a2aError("peer DNS unavailable")
	}
	for _, a := range addresses {
		if !publicfetch.IsPublicAddress(a) {
			return nil, a2aError("unsafe peer DNS result")
		}
	}
	pinned := net.JoinHostPort(addresses[0].String(), "443")
	transport := &http.Transport{DisableCompression: true, DisableKeepAlives: true, TLSClientConfig: &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", pinned)
	}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, e := http.NewRequestWithContext(ctx, "POST", address, bytes.NewReader(body))
	if e != nil {
		return nil, e
	}
	// A durable reservation records the sole dispatch. Prevent net/http from
	// replaying the body after a reused-connection transport failure.
	req.GetBody = nil
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Galaxy-Official/0.1")
	req.Header.Set("A2A-Version", "1.0")
	if credential != "" {
		req.Header.Set("Authorization", "Bearer "+credential)
	}
	response, e := client.Do(req)
	if e != nil {
		return nil, a2aError("peer request failed; outcome may be unknown")
	}
	defer response.Body.Close()
	media := strings.ToLower(response.Header.Get("Content-Type"))
	if response.StatusCode != 200 || media != "application/json" && !strings.HasPrefix(media, "application/json;") || response.Header.Get("Content-Encoding") != "" {
		return nil, a2aError("invalid peer response")
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 1048577))
	if e != nil || len(raw) > 1048576 || !utf8.Valid(raw) {
		return nil, a2aError("invalid peer response body")
	}
	raw = bytes.TrimPrefix(raw, []byte{0xef, 0xbb, 0xbf})
	if !json.Valid(raw) {
		return nil, a2aError("invalid peer JSON")
	}
	return raw, nil
}

// Each original SDK client is made for one operation, so its JSON-RPC counter
// starts at one. Protocol version 1.0 uses SendMessage/GetTask/CancelTask;
// message/send and tasks/get belong to the legacy profile and are not used.
func a2aRPC(ctx context.Context, post A2aPost, endpoint, credential, method string, params any) (any, error) {
	if method != "SendMessage" && method != "GetTask" && method != "CancelTask" {
		return nil, a2aError("unsupported peer method")
	}
	wire := protocol.NewOrderedObject()
	wire.Set("jsonrpc", "2.0")
	wire.Set("method", method)
	wire.Set("params", params)
	wire.Set("id", 1)
	raw, e := protocol.EncodeJS(wire)
	if e != nil || len(raw) > 32768 {
		return nil, a2aError("encoded request limit exceeded")
	}
	if post == nil {
		post = a2aPostPublic
	}
	raw, e = post(ctx, endpoint, raw, credential)
	if e != nil {
		return nil, e
	}
	if len(raw) > 1048576 || !utf8.Valid(raw) {
		return nil, a2aError("invalid peer response")
	}
	value, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, a2aError("invalid peer JSON")
	}
	o, ok := value.(*protocol.OrderedObject)
	if !ok {
		return nil, a2aError("invalid peer response")
	}
	fields := o.Values()
	if peer := a2aObject(fields["error"]); peer != nil {
		return nil, a2aRPCError(a2aInteger(peer["code"]))
	}
	if n, ok := fields["id"].(json.Number); !ok || n != "1" {
		return nil, a2aError("peer response ID mismatch")
	}
	result := fields["result"]
	if method == "SendMessage" {
		v := a2aObject(result)
		if v["task"] != nil {
			return a2aTaskWire(v["task"]), nil
		}
		if v["message"] != nil {
			return a2aProjection("message", v["message"]), nil
		}
		return nil, a2aError("missing response payload")
	}
	if a2aObject(result) == nil {
		return nil, a2aError("missing peer task")
	}
	return a2aTaskWire(result), nil
}
func a2aTaskWire(value any) *protocol.OrderedObject {
	v := a2aProjection("task", value)
	if _, ok := v.Values()["id"]; !ok {
		v.Set("id", "")
	}
	return v
}
func a2aObject(value any) map[string]any {
	if v, ok := value.(*protocol.OrderedObject); ok {
		return v.Values()
	}
	return uploadObject(value)
}
