package httpboundary

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type quotaEvent struct {
	Kind, ID, Method, Path, Address, Subject, Credential string
	HasCredential                                        bool
	At                                                   int64
	Current                                              *struct {
		AccountID string `json:"accountId"`
		ExpiresAt int64  `json:"expiresAt"`
	}
}

func TestOriginalFixedWindowQuotaParity(t *testing.T) {
	policy := DefaultQuotaPolicy()
	policy.WindowMs = 1000
	policy.CapacityPerCategory = 6
	policy.Categories.Query = Dimensions{3, 2, 1}
	policy.Categories.Anonymous = Dimensions{2, 2, 2}
	subject := "GUID" + strings.Repeat("A", 28)
	subject2 := "GUID" + strings.Repeat("B", 28)
	token := strings.Repeat("A", 43)
	events := []quotaEvent{{Kind: "begin", ID: "a", Method: "GET", Path: "/v1/history/query", Address: "ip-a", HasCredential: true, At: 100000}, {Kind: "capture", ID: "a", Subject: subject, Credential: "credential-a"}, {Kind: "begin", ID: "b", Method: "GET", Path: "/v1/history/query", Address: "ip-a", HasCredential: true}, {Kind: "capture", ID: "b", Subject: subject, Credential: "credential-a"}, {Kind: "begin", ID: "c", Method: "GET", Path: "/v1/history/query", Address: "ip-a", HasCredential: true}, {Kind: "capture", ID: "c", Subject: subject, Credential: "credential-b"}, {Kind: "begin", ID: "d", Method: "GET", Path: "/v1/history/query", Address: "ip-a", HasCredential: true}, {Kind: "begin", ID: "e", Method: "GET", Path: "/v1/history/query", Address: "ip-b", HasCredential: true}, {Kind: "capture", ID: "e", Subject: subject2, Credential: "credential-c"}, {Kind: "begin", ID: "f", Method: "GET", Path: "/v1/history/query", Address: "ip-c", HasCredential: true}, {Kind: "capture", ID: "f", Subject: subject, Credential: "credential-d"}, {Kind: "begin", ID: "g", Method: "GET", Path: "/v1/history/query", Address: "ip-a", HasCredential: true, At: 100999}, {Kind: "begin", ID: "h", Method: "GET", Path: "/v1/history/query", Address: "ip-a", HasCredential: true, At: 101000}, {Kind: "private", Address: "ip-a"}, {Kind: "private", Address: "ip-a"}, {Kind: "private", Address: "ip-a"}, {Kind: "private", Address: "ip-a"}, {Kind: "fixed", Address: "fixed-a"}, {Kind: "fixed", Address: "fixed-b"}, {Kind: "fixed", Address: "fixed-a"}, {Kind: "fixed", Address: "fixed-a"}, {Kind: "fixed", Address: "fixed-c"}, {Kind: "fixed", Address: "fixed-c", At: 161000}}
	for i := range 3 {
		events = append(events, quotaEvent{Kind: "website", Method: "GET", Path: "/v1/account/settings", Address: "random-cookie", Credential: token, At: 162000 + int64(i)})
	}
	events = append(events, quotaEvent{Kind: "website", Method: "GET", Path: "/v1/account/settings", Address: "real-account", Credential: token, At: 163100, Current: &struct {
		AccountID string `json:"accountId"`
		ExpiresAt int64  `json:"expiresAt"`
	}{"11111111-1111-4111-8111-111111111111", 1000}}, quotaEvent{Kind: "website", Method: "GET", Path: "/v1/account/settings", Address: "real-account", Credential: token, Current: &struct {
		AccountID string `json:"accountId"`
		ExpiresAt int64  `json:"expiresAt"`
	}{"11111111-1111-4111-8111-111111111111", 1000}})
	out, e := os.ReadFile("testdata/http-quota.json")
	if e != nil {
		t.Fatal(e)
	}
	var oracle struct {
		QuotaEvents []struct {
			Code    *string
			Headers map[string]string
		}
		PolicyHash    string
		DefaultPolicy QuotaPolicy
	}
	if e = json.Unmarshal(out, &oracle); e != nil {
		t.Fatal(e)
	}
	now := int64(100000)
	quota, _ := NewQuotas(policy, func() int64 { return now })
	private, _ := NewQuotas(policy, func() int64 { return now })
	fixed, _ := NewFixedWindow(2, 2, func() int64 { return now })
	pending := map[string]func(string, string) error{}
	writers := map[string]*httptest.ResponseRecorder{}
	if quota.PolicyHash() != oracle.PolicyHash || !reflect.DeepEqual(DefaultQuotaPolicy(), oracle.DefaultPolicy) {
		t.Fatal("original parsed policy hash/default differs")
	}
	for i, event := range events {
		if event.At != 0 {
			now = event.At
		}
		w := httptest.NewRecorder()
		var err error
		switch event.Kind {
		case "begin":
			var capture func(string, string) error
			capture, err = quota.Begin(event.Method, event.Path, event.Address, event.HasCredential, w)
			if err == nil {
				pending[event.ID] = capture
				writers[event.ID] = w
			}
		case "capture":
			if capture := pending[event.ID]; capture != nil {
				delete(pending, event.ID)
				w = writers[event.ID]
				err = capture(event.Subject, event.Credential)
			}
		case "private":
			err = private.BeginVerifiedService(event.Address, w)
		case "fixed":
			err = fixed.Consume(event.Address, w)
		case "website":
			r := httptest.NewRequest(event.Method, "https://api.example.invalid"+event.Path, nil)
			err = quota.BeginWebsite(r, event.Path, event.Address, event.Credential, w, func(*http.Request) (string, int64, error) {
				if event.Current == nil {
					return "", 0, nil
				}
				return event.Current.AccountID, event.Current.ExpiresAt, nil
			})
		}
		code := ""
		if err != nil {
			code = fault.Code(err)
		}
		want := ""
		if oracle.QuotaEvents[i].Code != nil {
			want = *oracle.QuotaEvents[i].Code
		}
		headers := map[string]string{}
		for k, v := range w.Header() {
			headers[strings.ToLower(k)] = strings.Join(v, ", ")
		}
		if code != want || !reflect.DeepEqual(headers, oracle.QuotaEvents[i].Headers) {
			t.Fatalf("quota step %d kind=%s: %s %v want %s %v", i, event.Kind, code, headers, want, oracle.QuotaEvents[i].Headers)
		}
	}
}
func TestCaptureCachesConcurrentRejectionAndCountsOnce(t *testing.T) {
	var calls atomic.Int32
	state := &requestState{capture: func(string, string) error { calls.Add(1); return fault.New("rate_limited", 429) }}
	ctx := context.WithValue(context.Background(), contextKey{}, state)
	var wg sync.WaitGroup
	errors := make(chan error, 16)
	for range 16 {
		wg.Go(func() { errors <- CaptureAuthenticated(ctx, "GUID"+strings.Repeat("A", 28), "credential") })
	}
	wg.Wait()
	close(errors)
	for e := range errors {
		if fault.Code(e) != "rate_limited" {
			t.Fatalf("cached failure changed: %v", e)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("authentication quota consumed %d times", calls.Load())
	}
}
func TestBoundaryActualHTTPPreflightAndVerifiedAccount(t *testing.T) {
	policy := DefaultQuotaPolicy()
	policy.Categories.Query = Dimensions{30, 10, 1}
	var nextCalls, accountReads atomic.Int32
	boundary, e := New(Config{Endpoint: "https://api.example.invalid", Origins: []string{"https://web.example.invalid"}, QuotaPolicy: &policy, NowMs: func() int64 { return 100000 }, AccountQuotaSession: func(*http.Request) (string, int64, error) {
		accountReads.Add(1)
		return "11111111-1111-4111-8111-111111111111", 1000, nil
	}})
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(boundary.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalls.Add(1)
		if r.Header.Get("Authorization") != "" {
			for range 2 {
				if e := CaptureAuthenticated(r.Context(), "GUID"+strings.Repeat("A", 28), "real-verified-credential"); e != nil {
					w.WriteHeader(fault.Status(e))
					return
				}
			}
		}
		w.WriteHeader(204)
	})))
	defer server.Close()
	send := func(method, path string, headers map[string]string) *http.Response {
		t.Helper()
		r, _ := http.NewRequest(method, server.URL+path, nil)
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		res, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		return res
	}
	first := send("GET", "/controlled-read", map[string]string{"Authorization": "Bearer actual-domain-verification"})
	if first.StatusCode != 204 {
		t.Fatal("first credential rejected")
	}
	second := send("GET", "/controlled-read", map[string]string{"Authorization": "Bearer actual-domain-verification"})
	if second.StatusCode != 429 || second.Header.Get("X-Galaxy-Quota-Dimension") != "credential" {
		t.Fatal("verified credential did not use its bounded bucket")
	}
	before := nextCalls.Load()
	preflight := send("OPTIONS", "/v1/account/settings", map[string]string{"Origin": "https://web.example.invalid", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "X-Galaxy-Account-ID, X-Galaxy-Account-CSRF"})
	if preflight.StatusCode != 204 || preflight.Header.Get("Access-Control-Allow-Credentials") != "true" || nextCalls.Load() != before {
		t.Fatal("preflight dispatched or lost credential CORS")
	}
	denied := send("GET", "/v1/account/settings", map[string]string{"Origin": "https://unlisted.example.invalid", "Cookie": "__Host-galaxy-account=" + strings.Repeat("A", 43)})
	if denied.StatusCode != 403 || accountReads.Load() != 0 {
		t.Fatal("unlisted browser origin reached account session lookup")
	}
	account := send("GET", "/v1/account/settings", map[string]string{"Origin": "https://web.example.invalid", "Cookie": "__Host-galaxy-account=" + strings.Repeat("B", 43)})
	if account.StatusCode != 204 || accountReads.Load() != 1 {
		t.Fatal("verified account did not reach bounded session lookup")
	}
	directory := t.TempDir()
	file := filepath.Join(directory, "browser.json")
	if e = os.WriteFile(file, []byte(`{"Version":1,"origins":[]}`), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = LoadBrowserPolicy(file); e == nil {
		t.Fatal("case-alias configuration fields accepted")
	}
}
