package discovery

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type legacyIdentity func(context.Context, string, string) (deviceauth.Actor, error)

func (f legacyIdentity) Authenticate(ctx context.Context, token, scope string) (deviceauth.Actor, error) {
	return f(ctx, token, scope)
}
func TestLegacyHTTPOriginalScopesBodyQuotaAndOrderedWire(t *testing.T) {
	calls, quotas := 0, 0
	scope := ""
	handler := LegacyHandler{Service: &LegacySearch{}, Devices: legacyIdentity(func(_ context.Context, token, s string) (deviceauth.Actor, error) {
		calls++
		scope = s
		if token != "synthetic" {
			t.Fatal("credential changed")
		}
		return deviceauth.Actor{SubjectID: "GUID" + strings.Repeat("A", 28)}, nil
	}), ConsumeSearchPage: func(_ *http.Request, a *deviceauth.Actor, after any) error {
		quotas++
		if a == nil || after != "00000000-0000-4000-8000-000000000001" {
			t.Fatal("quota identity/cursor changed")
		}
		return fault.New("controlled_page_quota", 429)
	}}
	request := func(body, auth string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/search/query", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if auth != "absent" {
			r.Header.Set("Authorization", auth)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for kind, want := range map[string]string{"case": "history", "history": "history", "proof": "proof", "capsule": "capsules", "worker": "builders", "hub": "builders"} {
		w := request(jsonString(Object{"type": kind, "query": Object{"after": "00000000-0000-4000-8000-000000000001"}}), "Bearer synthetic")
		if w.Code != 429 || scope != want {
			t.Fatalf("%s scope=%s status=%d", kind, scope, w.Code)
		}
	}
	before := calls
	if w := request(`{"type":"proof","query":{"limit":21}}`, "Bearer synthetic"); w.Code != 400 || calls != before {
		t.Fatal("invalid typed body reached authentication")
	}
	if w := request(strings.Repeat(" ", 32769), "Bearer synthetic"); w.Code != 413 || calls != before {
		t.Fatal("oversized body reached authentication")
	}
	if w := request(`{"type":"case","query":{}}`, ""); w.Code != 401 {
		t.Fatal("empty authorization became anonymous")
	}
	handler.ConsumeSearchPage = nil
	handler.Service = &LegacySearch{Endpoint: "https://search.example.invalid", HistoryQuery: func(context.Context, *deviceauth.Actor, []byte, []string) (json.RawMessage, error) {
		return json.RawMessage(`{"items":[],"nextCursor":null,"search":{"windowLimited":false}}`), nil
	}}
	w := request(`{"type":"case","query":{}}`, "absent")
	if w.Code != 200 || calls != before || quotas != 6 || !strings.HasPrefix(w.Body.String(), `{"version":1,"type":"case","items":[]`) {
		t.Fatalf("anonymous original wire changed %d %s", w.Code, w.Body.String())
	}
	preserved := httptest.NewRecorder()
	preserved.Header().Set("X-Request-ID", "00000000-0000-4000-8000-000000000001")
	r := httptest.NewRequest(http.MethodPost, "/v1/search/query", strings.NewReader(`{}`))
	handler.ServeHTTP(preserved, r)
	if preserved.Header().Get("X-Request-ID") != "00000000-0000-4000-8000-000000000001" {
		t.Fatal("outer verified request ID overwritten")
	}
}
