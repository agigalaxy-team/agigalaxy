package native

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHelpNumbersMatchRealConnectionReceiptsAndLocalSnapshots(t *testing.T) {
	for _, value := range []any{json.Number("1"), json.Number("9007199254740991"), float64(1), int64(1), int(1)} {
		if !helpSafeInteger(value) {
			t.Fatalf("valid HTTP/local integer rejected: %T %v", value, value)
		}
	}
	for _, value := range []any{json.Number("1.5"), json.Number("9007199254740992"), json.Number("-1"), float64(1.5), int64(9007199254740992), "1", nil} {
		if helpSafeInteger(value) {
			t.Fatalf("invalid receipt integer accepted: %T %v", value, value)
		}
	}
}

func TestHelpBusinessPublicationKeepsOriginalOperationAndNoDeadline(t *testing.T) {
	ctx := context.Background()
	store, _ := fixture(t)
	h := NewNativeHelp(commandRuntime(t, store))
	started, e := h.Call(ctx, "galaxy_help_start", map[string]any{"localTaskRef": "opencode/current-work"})
	if e != nil {
		t.Fatal(e)
	}
	id := text(psObject(started)["id"])
	input := map[string]any{"sessionId": id, "kind": "publish-task", "request": map[string]any{"title": "需要连接诊断", "summary": "只公开此摘要", "goal": "恢复连接", "currentSituation": "已确认端口可达，认证仍失败"}}
	first, e := h.Call(ctx, "galaxy_help_prepare_action", input)
	if e != nil {
		t.Fatal(e)
	}
	p := psObject(first)
	payload := psObject(p["payload"])
	if !controlUUID(p["operationId"]) || !controlUUID(p["taskId"]) || payload["enrollmentExpiresAt"] != nil || payload["caseId"] != nil || payload["summary"] != "只公开此摘要" || len(trustArray(payload["materials"])) != 0 {
		t.Fatal("business request acquired unselected data, an invented formal source or a deadline", first)
	}
	l, e := h.begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = l.operation(ctx, id, text(p["operationId"]), func(row map[string]any) (map[string]any, error) { row["state"] = "unknown"; return row, nil }); e != nil {
		t.Fatal(e)
	}
	again, e := h.Call(ctx, "galaxy_help_prepare_action", input)
	if e != nil || psObject(again)["operationId"] != p["operationId"] || psObject(again)["payloadHash"] != p["payloadHash"] || psObject(again)["state"] != "unknown" {
		t.Fatal("repeat preparation lost the uncertain original operation", again, e)
	}
	row, e := l.get(ctx, id)
	if e != nil || len(trustArray(row["actionOperations"])) != 1 || row["taskId"] != nil {
		t.Fatal("preparation created a second operation or claimed publication", row, e)
	}
}

type helpPublicQueryTransport struct{ requests int }

func (f *helpPublicQueryTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	f.requests++
	if r.URL.Path != "/v2/discovery/participants/query" || r.Header.Get("Authorization") != "" {
		return nil, helpError("unexpected_help_public_request")
	}
	return &http.Response{StatusCode: 200, Header: http.Header{}, Request: r, Body: io.NopCloser(strings.NewReader(`{"schemaVersion":2,"items":[],"nextAfter":null,"capabilityVerified":false}`))}, nil
}

func TestHelpPublicParticipantQueryNeedsNeitherIdentityNorSession(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "uninitialized")
	store, e := NewStore(dir, "https://public.invalid")
	if e != nil {
		t.Fatal(e)
	}
	transport := &helpPublicQueryTransport{}
	r, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: dir, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}})
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	result, e := NewNativeHelp(r).Call(ctx, "galaxy_help_query", map[string]any{"requests": []any{map[string]any{"requestId": "00000000-0000-4000-8000-000000000001", "kind": "participants-v2", "input": map[string]any{"query": "连接诊断"}}}})
	if e != nil || transport.requests != 1 || psObject(result)["sessionCreated"] != false || psObject(trustArray(psObject(result)["results"])[0])["state"] != "empty" {
		t.Fatal("public query could not read without a session", result, e)
	}
	if _, e = os.Stat(dir); !os.IsNotExist(e) {
		t.Fatal("public query initialized identity or persisted a help session", e)
	}
}

func TestHelpQueryBranchDefaultsPreserveOriginalRequestKinds(t *testing.T) {
	query := map[string]any{"requests": []any{
		map[string]any{"requestId": "00000000-0000-4000-8000-000000000001", "kind": "participants-v2", "input": map[string]any{"query": "DNS"}},
		map[string]any{"requestId": "00000000-0000-4000-8000-000000000002", "kind": "participant-v2", "input": map[string]any{"sourceKind": "builder", "id": "00000000-0000-4000-8000-000000000003"}},
		map[string]any{"requestId": "00000000-0000-4000-8000-000000000004", "kind": "search-v2", "input": map[string]any{"type": "history", "query": map[string]any{"query": "DNS"}}},
	}}
	got, e := helpInput("galaxy_help_query", query)
	if e != nil {
		t.Fatal("valid source queries were mixed with other union defaults", e)
	}
	rows := trustArray(got["requests"])
	participants := psObject(psObject(rows[0])["input"])
	detail := psObject(psObject(rows[1])["input"])
	search := psObject(psObject(rows[2])["input"])
	if len(participants) != 2 || psInt(participants["limit"]) != 20 || len(detail) != 2 || search["type"] != "history" || psObject(search["query"])["query"] != "DNS" {
		t.Fatal("source-specific defaults changed a different request", got)
	}
	snapshot := map[string]any{"requestId": psObject(rows[0])["requestId"], "kind": "participants-v2", "state": "empty", "checkedAt": 1, "basisKeys": []any{}, "request": rows[0]}
	session := map[string]any{"queries": []any{snapshot}}
	helpDefaults(helpSchema("session"), session)
	if len(psObject(psObject(psObject(trustArray(session["queries"])[0])["request"])["input"])) != 2 {
		t.Fatal("retaining a query snapshot introduced fields from another source", session)
	}
}

func TestHelpQueryKeywordsAndReadableResults(t *testing.T) {
	input, err := helpInput("galaxy_help_query", map[string]any{"query": "  DNS  "})
	if err != nil {
		t.Fatal(err)
	}
	requests := trustArray(input["requests"])
	if len(requests) != 2 || psObject(requests[0])["kind"] != "search-v2" || psObject(requests[1])["kind"] != "participants-v2" || psObject(psObject(requests[1])["input"])["query"] != "DNS" {
		t.Fatalf("wrong help sources: %v", input)
	}
	if _, err = helpInput("galaxy_help_query", map[string]any{"query": "  "}); err == nil || err.Error() != helpQueryInvalid {
		t.Fatalf("missing actionable query error: %v", err)
	}
	result := map[string]any{"queryDoesNotPublish": true, "results": []any{
		map[string]any{"kind": "search-v2", "state": "empty"},
		map[string]any{"kind": "participants-v2", "state": "failed"},
	}}
	if visible := strings.Join(nativeResultLines(result, false), "\n"); !strings.Contains(visible, "没有找到匹配") || !strings.Contains(visible, "暂未查到") {
		t.Fatalf("query states hidden from text-only hosts: %q", visible)
	}
}
