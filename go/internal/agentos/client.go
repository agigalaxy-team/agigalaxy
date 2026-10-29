// Package agentos connects the retained Agno runtime. Transport completion
// never establishes permission or the completion of a Galaxy business action.
package agentos

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

type Object = map[string]any
type Execution struct{ ID, Mode, Domain, SessionID string }
type Options struct {
	HTTPClient        *http.Client
	Now               func() time.Time
	AllowInternalHTTP bool
}
type Client struct {
	configuration Configuration
	http          *http.Client
	now           func() time.Time
}

func fail(code string, status int) error { return fault.New(code, status) }
func validURL(u *url.URL, internal bool) bool {
	return u != nil && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (u.Scheme == "https" || u.Scheme == "http" && (internal || u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"))
}
func New(configuration Configuration, options Options) (*Client, error) {
	if configuration.URL != "" {
		u, e := url.Parse(configuration.URL)
		if e != nil || !validURL(u, options.AllowInternalHTTP) {
			return nil, fail("operations_agentos_configuration_invalid", 503)
		}
	}
	client := http.Client{}
	if options.HTTPClient != nil {
		client = *options.HTTPClient
	}
	if client.Transport == nil {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.Proxy = nil
		client.Transport = transport
	} else if base, ok := client.Transport.(*http.Transport); ok {
		transport := base.Clone()
		transport.Proxy = nil
		client.Transport = transport
	}
	client.Jar = nil
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("agentos_redirect_rejected") }
	now := options.Now
	if now == nil {
		now = time.Now
	}
	configuration.URL = strings.TrimSuffix(configuration.URL, "/")
	return &Client{configuration: configuration, http: &client, now: now}, nil
}
func (c *Client) Configured() bool {
	return c != nil && c.configuration.URL != "" && protocol.TextLength(c.configuration.SigningKey) >= 32
}
func (c *Client) token(execution Execution) (string, error) {
	if !c.Configured() {
		return "", fail("operations_agentos_not_configured", 503)
	}
	prefix := "execution:"
	if execution.Mode == "conversation" {
		prefix = "conversation:"
	}
	at := c.now().Unix()
	claims := struct {
		Sub string `json:"sub"`
		Iss string `json:"iss"`
		Aud string `json:"aud"`
		Iat int64  `json:"iat"`
		Exp int64  `json:"exp"`
		JTI string `json:"jti"`
	}{prefix + execution.ID, "galaxy-operations", "galaxy-agentos", at, at + 60, uuid.NewString()}
	return c.signToken(claims)
}
func decodeResponse(response *http.Response) (any, error) {
	// Fetch text limits UTF-16 code units, rather than UTF-8 bytes. Three bytes
	// per code unit bounds the read without rejecting valid Chinese responses.
	body, e := io.ReadAll(io.LimitReader(response.Body, 12*1024*1024+1))
	if e != nil {
		return nil, fail("operations_agentos_result_unknown", 503)
	}
	body = bytes.TrimPrefix(body, []byte{0xef, 0xbb, 0xbf})
	if len(body) > 12*1024*1024 || protocol.TextLength(string(body)) > 4*1024*1024 {
		return nil, fail("operations_agentos_response_invalid", 503)
	}
	var result any
	if protocol.Decode(body, &result) != nil {
		return nil, fail("operations_agentos_response_invalid", 503)
	}
	return result, nil
}
func object(v any) Object { o, _ := v.(map[string]any); return o }
func (c *Client) request(ctx context.Context, execution Execution, path string, form url.Values, key string) (any, error) {
	token, e := c.token(execution)
	if e != nil {
		return nil, e
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	method := http.MethodGet
	var body io.Reader
	if form != nil {
		method = http.MethodPost
		body = strings.NewReader(form.Encode())
	}
	r, e := http.NewRequestWithContext(ctx, method, c.configuration.URL+path, body)
	if e != nil {
		return nil, fail("operations_agentos_configuration_invalid", 503)
	}
	// The original operation is recovered explicitly after a lost response.
	// net/http otherwise treats Idempotency-Key plus GetBody as permission to
	// replay a POST on a reused connection before our ledger can classify it.
	if form != nil {
		r.GetBody = nil
	}
	r.Header.Set("Authorization", "Bearer "+token)
	if form != nil {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	response, e := c.http.Do(r)
	if e != nil {
		return nil, fail("operations_agentos_result_unknown", 503)
	}
	defer response.Body.Close()
	result, e := decodeResponse(response)
	if e != nil {
		return nil, e
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if object(result)["error"] == "agentos_model_not_configured" {
			return nil, fail("operations_agentos_model_not_configured", 503)
		}
		if response.StatusCode == 503 && object(result)["error"] == "agentos_authority_unavailable" {
			return nil, fail("operations_authorization_unavailable", 503)
		}
		if response.StatusCode == 403 {
			return nil, fail("operations_agentos_authority_changed", 403)
		}
		return nil, fail("operations_agentos_request_failed", 503)
	}
	return result, nil
}
func (c *Client) Status(ctx context.Context) Object {
	base := Object{"state": "not-configured", "modelState": "not-configured", "framework": "agno", "version": "3.1.7"}
	if !c.Configured() {
		return base
	}
	base["state"], base["modelState"] = "unavailable", "unknown"
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	r, e := http.NewRequestWithContext(ctx, "GET", c.configuration.URL+"/health", nil)
	if e != nil {
		return base
	}
	response, e := c.http.Do(r)
	if e != nil {
		return base
	}
	defer response.Body.Close()
	data, e := decodeResponse(response)
	wire := object(data)
	if e != nil || response.StatusCode < 200 || response.StatusCode >= 300 || wire["framework"] != "agno" || wire["version"] != "3.1.7" || wire["state"] != "running" {
		return base
	}
	base["state"] = "connected"
	base["modelState"] = "not-configured"
	if wire["model"] == "configured" {
		base["modelState"] = "configured"
	}
	conversations := object(wire["conversations"])
	var version any
	if v, ok := index(conversations["version"]); ok && (v == 1 || v == 2) {
		version = v
	}
	base["conversationVersion"] = version
	agents, _ := conversations["agentIds"].([]any)
	domains := []any{}
	if version != nil {
		for _, domain := range []string{"overview", "governance", "messaging", "discovery", "maintenance"} {
			for _, agent := range agents {
				if agent == "galaxy-conversation-"+domain {
					domains = append(domains, domain)
					break
				}
			}
		}
	}
	base["conversationDomains"] = domains
	transport := object(conversations["transport"])
	flags := Object{}
	for _, key := range []string{"events", "cancel", "originalRunLookup"} {
		v, ok := index(transport[key])
		flags[key] = ok && v == 1
	}
	base["conversationTransport"] = flags
	if scenarios, ok := object(wire["modelSettings"])["scenarios"].([]any); ok {
		configured := []any{}
		for _, entry := range scenarios {
			if row := object(entry); row["state"] == "configured" {
				configured = append(configured, row["domain"])
			}
		}
		base["configuredDomains"] = configured
	}
	for _, key := range []string{"persistence", "queue", "traces"} {
		if value, present := wire[key]; present {
			base[key] = value
		}
	}
	return base
}
func (c *Client) Read(ctx context.Context, e Execution) (any, error) {
	return c.request(ctx, e, "/galaxy/executions/"+url.PathEscape(e.ID), nil, "")
}
func (c *Client) ReadConversation(ctx context.Context, e Execution) (any, error) {
	return c.request(ctx, e, "/galaxy/conversations/"+url.PathEscape(e.ID), nil, "")
}

type ConversationOperationLocator struct {
	RunID, RetryOfOperationID, RetryOfRunID string
}

func (c *Client) ReadConversationOperation(ctx context.Context, e Execution, id string, locator ConversationOperationLocator) (any, error) {
	path := "/galaxy/conversations/" + url.PathEscape(e.ID) + "/operations/" + url.PathEscape(id)
	if locator.RunID != "" {
		if !nativeRunID.MatchString(locator.RunID) || (locator.RetryOfOperationID == "") != (locator.RetryOfRunID == "") || locator.RetryOfOperationID != "" && (!validOperationID(locator.RetryOfOperationID) || locator.RetryOfOperationID == id || !nativeRunID.MatchString(locator.RetryOfRunID)) {
			return nil, streamInvalid()
		}
		query := url.Values{"runId": {locator.RunID}}
		if locator.RetryOfOperationID != "" {
			query.Set("retryOfOperationId", locator.RetryOfOperationID)
			query.Set("retryOfRunId", locator.RetryOfRunID)
		}
		path += "?" + query.Encode()
	} else if locator.RetryOfOperationID != "" || locator.RetryOfRunID != "" {
		return nil, streamInvalid()
	}
	return c.request(ctx, e, path, nil, "")
}
func (c *Client) CancelConversation(ctx context.Context, e Execution, id string) (any, error) {
	return c.request(ctx, e, "/agents/galaxy-conversation-"+url.PathEscape(e.Domain)+"/runs/"+url.PathEscape(id)+"/cancel?"+url.Values{"session_id": {e.SessionID}}.Encode(), url.Values{}, "")
}
func (c *Client) Run(ctx context.Context, e Execution, runID, message string, review bool) (any, error) {
	component := "agents/galaxy-" + url.PathEscape(e.Domain)
	session := e.SessionID
	if review {
		component = "workflows/galaxy-prepared-review"
		session += ":review"
	}
	return c.request(ctx, e, "/"+component+"/runs", url.Values{"message": {message}, "stream": {"false"}, "background": {"true"}, "session_id": {session}}, runID)
}
func (c *Client) Continue(ctx context.Context, e Execution, runID string, confirmed bool) (any, error) {
	current, err := c.Read(ctx, e)
	if err != nil {
		return nil, err
	}
	paused := false
	runs, _ := object(current)["runs"].([]any)
	for _, row := range runs {
		run := object(row)
		if run["runId"] == runID && run["awaitingHuman"] == true {
			paused = true
		}
	}
	if !paused {
		return nil, fail("operations_agentos_run_not_paused", 409)
	}
	decision := "false"
	if confirmed {
		decision = "true"
	}
	return c.request(ctx, e, "/galaxy/executions/"+url.PathEscape(e.ID)+"/continue", url.Values{"run_id": {runID}, "confirmed": {decision}}, "")
}
func (c *Client) metadata(ctx context.Context, path string) (any, error) {
	if !c.Configured() || protocol.TextLength(c.configuration.ServiceKey) < 32 {
		return nil, fail("operations_agentos_not_configured", 503)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	r, e := http.NewRequestWithContext(ctx, "GET", c.configuration.URL+path, nil)
	if e != nil {
		return nil, fail("operations_agentos_configuration_invalid", 503)
	}
	r.Header.Set("Authorization", "Bearer "+c.configuration.ServiceKey)
	response, e := c.http.Do(r)
	if e != nil {
		return nil, fail("operations_agentos_unavailable", 503)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == 404 {
			return nil, fail("operations_agentos_run_not_found", 404)
		}
		return nil, fail("operations_agentos_unavailable", 503)
	}
	return decodeResponse(response)
}
func (c *Client) Runs(ctx context.Context, query url.Values) (any, error) {
	return c.metadata(ctx, "/galaxy/runs?"+query.Encode())
}
func (c *Client) RunDetail(ctx context.Context, id string) (any, error) {
	return c.metadata(ctx, "/galaxy/runs/"+url.PathEscape(id))
}
