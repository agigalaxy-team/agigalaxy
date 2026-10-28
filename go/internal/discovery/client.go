package discovery

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type ClientOptions struct {
	HTTP    *http.Client
	Timeout time.Duration
}
type EngineError struct {
	Code         string
	NativeStatus int
}

func (e *EngineError) Error() string { return e.Code }
func (e *EngineError) Unwrap() error { return fault.New(e.Code, 503) }

type nativeClient struct {
	origin  string
	headers http.Header
	client  *http.Client
	timeout time.Duration
}

func newNative(origin string, headers http.Header, options ClientOptions) (nativeClient, error) {
	u, e := url.Parse(origin)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nativeClient{}, fail("discovery_configuration_invalid")
	}
	client := http.Client{}
	if options.HTTP != nil {
		client = *options.HTTP
	}
	client.Jar = nil
	switch transport := client.Transport.(type) {
	case nil:
		copy := http.DefaultTransport.(*http.Transport).Clone()
		copy.Proxy = nil
		client.Transport = copy
	case *http.Transport:
		copy := transport.Clone()
		copy.Proxy = nil
		client.Transport = copy
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("discovery redirect refused") }
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return nativeClient{origin: normalizedOrigin(u), headers: headers.Clone(), client: &client, timeout: timeout}, nil
}
func serviceSecret(value string) bool {
	return len(strings.TrimSpace(value)) >= 24 && !strings.ContainsAny(value, "\r\n")
}
func (c *nativeClient) call(ctx context.Context, path, method string, body any, allow404 bool) (any, error) {
	return c.callWith(ctx, path, method, body, callOptions{Allow404: allow404})
}

type callOptions struct {
	Allow404  bool
	UserAgent string
	Inspect   func(http.Header) error
}

func (c *nativeClient) callWith(ctx context.Context, path, method string, body any, options callOptions) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	var input io.Reader
	if body != nil {
		raw, e := json.Marshal(body)
		if e != nil {
			return nil, fail("discovery_engine_response_invalid")
		}
		input = bytes.NewReader(raw)
	}
	req, e := http.NewRequestWithContext(ctx, method, c.origin+path, input)
	if e != nil {
		return nil, fail("discovery_engine_unavailable")
	}
	req.Header = c.headers.Clone()
	if asciiUserAgent(options.UserAgent) {
		req.Header.Set("User-Agent", options.UserAgent)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, e := c.client.Do(req)
	if e != nil {
		return nil, fail("discovery_engine_unavailable")
	}
	defer response.Body.Close()
	if options.Allow404 && response.StatusCode == 404 {
		return nil, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == 401 || response.StatusCode == 403 {
			return nil, &EngineError{Code: "discovery_engine_authorization_failed", NativeStatus: response.StatusCode}
		}
		return nil, &EngineError{Code: "discovery_engine_failed", NativeStatus: response.StatusCode}
	}
	if options.Inspect != nil {
		if e = options.Inspect(response.Header); e != nil {
			return nil, e
		}
	}
	if response.StatusCode == 204 {
		return nil, nil
	}
	raw, e := io.ReadAll(response.Body)
	if e != nil {
		return nil, fail("discovery_engine_response_invalid")
	}
	var result any
	if e = decode(raw, &result); e != nil {
		return nil, fail("discovery_engine_response_invalid")
	}
	return result, nil
}
func asciiUserAgent(value string) bool {
	if len(value) < 1 || len(value) > 512 {
		return false
	}
	for _, b := range []byte(value) {
		if b < 0x20 || b > 0x7e {
			return false
		}
	}
	return true
}
