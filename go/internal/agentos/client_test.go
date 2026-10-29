package agentos

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func verifyFixtureToken(key, token string) (Object, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, false
	}
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	signature, e := base64.RawURLEncoding.DecodeString(parts[2])
	if e != nil || !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, false
	}
	payload, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return nil, false
	}
	var claims Object
	if protocol.Decode(payload, &claims) != nil {
		return nil, false
	}
	return claims, true
}

func TestOriginalJWTAndClosedStreamProjection(t *testing.T) {
	key := strings.Repeat("local-fixture-", 4)
	client, e := New(Configuration{URL: "https://agentos.invalid", SigningKey: key}, Options{Now: func() time.Time { return time.Unix(2000000000, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	token, e := client.token(Execution{ID: "original-conversation", Mode: "conversation"})
	if e != nil {
		t.Fatal(e)
	}
	claims, valid := verifyFixtureToken(key, token)
	if !valid {
		t.Fatal("JWT signature invalid")
	}
	if claims["sub"] != "conversation:original-conversation" || claims["iss"] != "galaxy-operations" || claims["aud"] != "galaxy-agentos" || claims["iat"] != json.Number("2000000000") || claims["exp"] != json.Number("2000000060") {
		t.Fatal("native JWT contract changed")
	}
	cases := []Object{}
	for _, frame := range []Object{
		{"event": "RunContent", "run_id": "run-1", "event_index": 8, "content": "银河的回复", "content_type": "str"},
		{"event": "RunContent", "run_id": "run-1", "content": "unindexed"},
		{"event": "RunContent", "run_id": "run-1", "event_index": 7, "content": "duplicate"},
		{"event": "RunContent", "run_id": "other", "event_index": 9, "content": "wrong run"},
		{"event": "RunReasoningContent", "run_id": "run-1", "event_index": 9, "content": "private reasoning"},
		{"event": "ToolCallStarted", "run_id": "run-1", "event_index": 10, "tool_args": Object{"private": "must not project"}},
		{"event": "ToolCallCompleted", "run_id": "run-1"},
		{"event": "RunCompleted", "run_id": "run-1", "event_index": 11},
		{"event": "catch_up", "run_id": "run-1", "status": "paused"},
		{"event": "error"},
	} {
		cases = append(cases, Object{"frame": frame, "runId": "run-1", "after": 7})
	}
	// Original closed stream projection captured once from the Node client.
	raw, e := os.ReadFile("testdata/original-stream-frames.json")
	if e != nil {
		t.Fatal(e)
	}
	var expected []any
	if protocol.Decode(raw, &expected) != nil {
		t.Fatal("invalid captured stream projection")
	}
	for i, row := range cases {
		actual := ConversationStreamEvent(object(row["frame"]), "run-1", 7)
		raw, _ := json.Marshal(actual)
		var normalized any
		_ = protocol.Decode(raw, &normalized)
		if !reflect.DeepEqual(normalized, expected[i]) {
			t.Fatalf("closed frame %d differs", i)
		}
	}
}

func TestActualHTTPSubmissionStreamResumeAndUnknownRecovery(t *testing.T) {
	var submits, lookups, resumes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			if r.Header.Get("Authorization") != "" {
				t.Error("health received a credential")
			}
			io.WriteString(w, `{"framework":"agno","version":"3.1.7","state":"running","model":"configured","conversations":{"version":2,"agentIds":["galaxy-conversation-overview"],"transport":{"events":1,"cancel":1,"originalRunLookup":1}}}`)
		case "/agents/galaxy-conversation-overview/runs":
			submits.Add(1)
			_ = r.ParseForm()
			if r.Header.Get("Idempotency-Key") != "operation-1" || r.Form.Get("session_id") != "original-session" || r.Form.Get("message") != "你好" || r.Form.Get("background") != "true" {
				t.Error("submission changed original intent")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, "data: {\"event\":\"RunStarted\",\"run_id\":\"run-1\",\"session_id\":\"original-session\",\"agent_id\":\"galaxy-conversation-overview\"}\n\n")
			w.(http.Flusher).Flush()
		case "/agents/galaxy-conversation-overview/runs/run-1/resume":
			resumes.Add(1)
			_ = r.ParseForm()
			if r.Form.Get("last_event_index") != "7" {
				t.Error("original stream position lost")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			for _, frame := range []Object{{"event": "RunContent", "run_id": "run-1", "event_index": 7, "content": "old"}, {"event": "RunReasoningContent", "run_id": "run-1", "event_index": 8, "content": "private"}, {"event": "RunContent", "run_id": "run-1", "event_index": 9, "content": "流式内容"}, {"event": "RunCompleted", "run_id": "run-1", "event_index": 10}} {
				raw, _ := json.Marshal(frame)
				io.WriteString(w, "data: "+string(raw)+"\n\n")
				w.(http.Flusher).Flush()
			}
		case "/galaxy/conversations/conversation-1/operations/operation-1":
			lookups.Add(1)
			io.WriteString(w, `{"run_id":"run-1","state":"running"}`)
		default:
			w.WriteHeader(404)
			io.WriteString(w, `{"error":"missing"}`)
		}
	}))
	defer server.Close()
	client, e := New(Configuration{URL: server.URL, SigningKey: strings.Repeat("x", 32)}, Options{})
	if e != nil {
		t.Fatal(e)
	}
	if client.Status(context.Background())["state"] != "connected" {
		t.Fatal("configured original health failed")
	}
	context := context.Background()
	conversation := Execution{ID: "conversation-1", Mode: "conversation", Domain: "overview", SessionID: "original-session"}
	result, e := client.RunConversation(context, conversation, ConversationRun{RunID: "operation-1", Message: "你好", Stream: true})
	if e != nil || object(result)["run_id"] != "run-1" {
		t.Fatal("native submission not accepted", e)
	}
	events := []Object{}
	if e = client.ConversationEvents(context, conversation, "run-1", 7, func(event Object) error { events = append(events, event); return nil }); e != nil {
		t.Fatal(e)
	}
	if len(events) != 2 || events[0]["text"] != "流式内容" || events[1]["kind"] != "terminal" {
		t.Fatal("stream replay or reasoning leaked")
	}
	if _, e = client.ReadConversationOperation(context, conversation, "operation-1"); e != nil {
		t.Fatal(e)
	}
	if submits.Load() != 1 || resumes.Load() != 1 || lookups.Load() != 1 {
		t.Fatal("original operation was resubmitted")
	}
}

func TestRedirectAndLostReplyNeverReplaySubmission(t *testing.T) {
	var leaked, attempts atomic.Int32
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1) }))
	defer trap.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		if strings.HasPrefix(r.URL.Path, "/agents/") {
			conn, _, _ := w.(http.Hijacker).Hijack()
			_ = conn.Close()
			return
		}
		http.Redirect(w, r, trap.URL, 302)
	}))
	defer server.Close()
	client, _ := New(Configuration{URL: server.URL, SigningKey: strings.Repeat("x", 32), ServiceKey: strings.Repeat("y", 32)}, Options{})
	_, e := client.Run(context.Background(), Execution{ID: "execution-1", Domain: "overview"}, "operation-1", "message", false)
	if fault.Code(e) != "operations_agentos_result_unknown" || attempts.Load() != 1 {
		t.Fatal("lost submission was not left unknown")
	}
	_, e = client.Read(context.Background(), Execution{ID: "original"})
	if fault.Code(e) != "operations_agentos_result_unknown" {
		t.Fatal("redirect changed original request failure classification")
	}
	_, e = client.RunDetail(context.Background(), "original-run")
	if fault.Code(e) != "operations_agentos_unavailable" || leaked.Load() != 0 {
		t.Fatal("service credential followed redirect")
	}
	for _, raw := range []string{"data: {\"x\":1}", "data: invalid\n\n", "data: \xff\n\n", "data: " + strings.Repeat("x", 1024*1024) + "\n\n"} {
		if ReadNativeFrames(strings.NewReader(raw), func(Object) (bool, error) { return true, nil }) == nil {
			t.Fatal("invalid SSE accepted")
		}
	}
}
