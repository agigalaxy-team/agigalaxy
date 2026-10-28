package agentos

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type strategyRequestInspector struct {
	t    *testing.T
	next http.RoundTripper
}

func (s strategyRequestInspector) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method == http.MethodPost && r.GetBody != nil {
		s.t.Error("strategy transport may replay a business POST")
	}
	return s.next.RoundTrip(r)
}

func TestStrategyTransportClosedWorkflowAndOriginalExecution(t *testing.T) {
	ctx := context.Background()
	executionID, runID, sessionID, operationID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	var health, calls, posts atomic.Int32
	var lose, badWorkflow atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			health.Add(1)
			if r.Header.Get("Authorization") != "" {
				t.Error("health received execution credentials")
			}
			workflow := "ready"
			if badWorkflow.Load() {
				workflow = "unavailable"
			}
			_ = json.NewEncoder(w).Encode(Object{"framework": "agno", "version": "3.1.7", "state": "running", "strategies": Object{"state": workflow, "workflowId": strategyWorkflow, "workflowVersion": 1}})
			return
		}
		calls.Add(1)
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		if len(parts) != 3 {
			t.Error("execution JWT missing")
			w.WriteHeader(403)
			return
		}
		raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
		var claims Object
		if json.Unmarshal(raw, &claims) != nil || claims["sub"] != "execution:"+executionID {
			t.Error("workflow execution scope changed")
		}
		if !strings.HasPrefix(r.URL.Path, "/galaxy/p13-strategies/"+runID) {
			t.Error("workflow path changed")
		}
		if r.Method == http.MethodPost {
			posts.Add(1)
			_ = r.ParseForm()
			if r.Form.Get("session_id") != sessionID {
				t.Error("workflow session changed")
			}
			want := operationID
			if strings.HasSuffix(r.URL.Path, "/start") {
				want = runID
			}
			if r.Header.Get("Idempotency-Key") != want {
				t.Error("original operation key changed")
			}
			if lose.Load() {
				c, _, _ := w.(http.Hijacker).Hijack()
				_ = c.Close()
				return
			}
		}
		io.WriteString(w, `{"state":"not-recorded"}`)
	}))
	defer server.Close()
	transport := &http.Transport{Proxy: nil}
	defer transport.CloseIdleConnections()
	client, err := New(Configuration{URL: server.URL, SigningKey: strings.Repeat("x", 32)}, Options{HTTPClient: &http.Client{Transport: strategyRequestInspector{t, transport}}})
	if err != nil {
		t.Fatal(err)
	}
	status, err := client.StrategyStatus(ctx)
	if err != nil || status["state"] != "connected" || health.Load() != 2 {
		t.Fatal("workflow health", status, err)
	}
	for _, call := range []struct {
		suffix string
		form   url.Values
		key    string
	}{
		{"", nil, ""}, {"/start", url.Values{"session_id": {sessionID}}, runID}, {"/continue", url.Values{"session_id": {sessionID}, "confirmed": {"false"}}, operationID}, {"/continuations/" + operationID, nil, ""},
	} {
		if _, err = client.StrategyRequest(ctx, executionID, runID, call.suffix, call.form, call.key); err != nil {
			t.Fatal(err)
		}
	}
	before := calls.Load()
	if _, err = client.StrategyRequest(ctx, executionID, runID, "/../other", nil, ""); err == nil || calls.Load() != before {
		t.Fatal("unrecognized workflow path reached network")
	}
	lose.Store(true)
	beforePosts := posts.Load()
	if _, err = client.StrategyRequest(ctx, executionID, runID, "/continue", url.Values{"session_id": {sessionID}, "input_decision": {"selected"}}, operationID); fault.Code(err) != "operations_agentos_result_unknown" || posts.Load() != beforePosts+1 {
		t.Fatal("lost workflow result replayed", err)
	}
	badWorkflow.Store(true)
	status, err = client.StrategyStatus(ctx)
	if err != nil || status["state"] != "not-connected" {
		t.Fatal("missing workflow advertised ready", status, err)
	}
}
