package native

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestHelpMCPViewKeepsCurrentResultsAndOriginalSession(t *testing.T) {
	session := map[string]any{"id": "session", "revision": 3, "pauseState": "active", "taskId": "task", "queries": []any{"previous"}, "basis": []any{"evidence"}, "offers": []any{"offer"}, "selectedHelpIds": []any{"offer"}, "paths": []any{"guide"}, "warnings": []any{"guide"}, "requestDefaults": map[string]any{"visibility": "Public"}, "activeEntries": []any{"guide"}}
	original := map[string]any{"session": session, "results": []any{map[string]any{"requestId": "r", "basis": []any{"current"}, "data": map[string]any{"participant": map[string]any{"id": "p"}}}}}
	view := helpMCPView("galaxy_help_query", original).(map[string]any)
	got := view["session"].(map[string]any)
	for _, key := range []string{"queries", "basis", "offers", "paths", "warnings", "requestDefaults", "activeEntries"} {
		if _, ok := got[key]; ok {
			t.Errorf("query session retained %s", key)
		}
	}
	for _, key := range []string{"id", "revision", "pauseState", "taskId", "selectedHelpIds"} {
		if _, ok := got[key]; !ok {
			t.Errorf("missing session %s", key)
		}
	}
	if len(view["results"].([]any)) != 1 || len(session["queries"].([]any)) != 1 {
		t.Fatal("current results or original changed")
	}
	full := helpMCPView("galaxy_help_get", session).(map[string]any)
	if _, ok := full["offers"]; !ok {
		t.Fatal("get lost offers")
	}
	if _, ok := full["basis"]; !ok {
		t.Fatal("get lost basis")
	}
	if _, ok := full["warnings"]; ok {
		t.Fatal("static guidance retained")
	}
	for _, name := range []string{"galaxy_help_refresh", "galaxy_help_return"} {
		s := helpMCPView(name, original).(map[string]any)["session"].(map[string]any)
		if _, ok := s["queries"]; ok {
			t.Fatalf("%s retained queries", name)
		}
	}
}
func TestHelpMCPViewRemovesDuplicatePreparationBytes(t *testing.T) {
	preview := map[string]any{"operationId": "op", "payloadHash": "hash", "authorizationRequestId": "auth", "payload": map[string]any{"title": "title"}, "prepareInput": map[string]any{"payloadJson": "signed bytes", "kind": "publish-task"}}
	result := helpMCPView("galaxy_help_action_preview", preview).(map[string]any)
	prepare := result["prepareInput"].(map[string]any)
	if _, ok := prepare["payloadJson"]; ok {
		t.Fatal("duplicate payload retained")
	}
	if prepare["kind"] != "publish-task" || result["payloadHash"] != "hash" || result["authorizationRequestId"] != "auth" {
		t.Fatal("operation locator lost")
	}
	if preview["prepareInput"].(map[string]any)["payloadJson"] != "signed bytes" {
		t.Fatal("signed input mutated")
	}
	empty := helpMCPView("galaxy_help_action_preview", map[string]any{"prepareInput": map[string]any{"payloadJson": "x"}}).(map[string]any)
	if _, ok := empty["prepareInput"]; ok {
		t.Fatal("empty prepare input retained")
	}
	browser, _ := toolResult(map[string]any{"state": "user-choice-needs-browser", "preview": map[string]any{"preview": preview}})
	out, err := helpProjectReviewResult("galaxy_help_execute_action", browser)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err = json.Unmarshal([]byte(out.Content[0].(*mcp.TextContent).Text), &decoded); err != nil {
		t.Fatal(err)
	}
	nested := decoded["preview"].(map[string]any)["preview"].(map[string]any)
	if _, ok := nested["prepareInput"].(map[string]any)["payloadJson"]; ok {
		t.Fatal("browser preview retained payload bytes")
	}
}
func TestHelpChoiceTitleAndErrors(t *testing.T) {
	view := interactionBrowserView(BrowserChoiceInput{Name: "galaxy_help_execute_action", Input: map[string]any{"preview": map[string]any{"kind": "publish-task"}}, Message: "发布求助\n标题：证书链问题\n范围：公开"})
	if len(view.Rows) != 1 || view.Rows[0].Text != "标题：证书链问题\n范围：公开" {
		t.Fatal("confirmation repeated its heading or lost the actual content", view)
	}
	input := map[string]any{"preview": map[string]any{"kind": "task-event", "payload": map[string]any{"event": map[string]any{"kind": "apply"}}}}
	if got := userChoiceTitle("galaxy_help_execute_action", input); got != "发送协助意向" {
		t.Fatal("task action title did not use its actual event", got)
	}
	for _, test := range []struct{ kind, want string }{{"publish-task", "发布求助"}, {"participation-propose", "提出协作安排"}, {"context-grant", "分享材料"}} {
		input := map[string]any{"preview": map[string]any{"kind": test.kind}}
		if got := userChoiceTitle("galaxy_help_execute_action", input); got != test.want {
			t.Errorf("%s: %s", test.kind, got)
		}
		if got := interactionBrowserView(BrowserChoiceInput{Name: "galaxy_help_execute_action", Input: input}).Title; got != test.want {
			t.Errorf("browser: %s", got)
		}
	}
	result, err := helpToolError(helpError("help_session_changed"))
	if err != nil || !result.IsError {
		t.Fatal("missing error")
	}
	var data map[string]any
	if err = json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &data); err != nil {
		t.Fatal(err)
	}
	if data["error"] != "help_session_changed" || data["recovery"] == nil || data["message"] == nil {
		t.Fatal("missing error information", data)
	}
}

type helpDetailTransport struct{}

func (helpDetailTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path != "/v2/discovery/participants/detail" {
		return nil, helpError("unexpected_help_public_request")
	}
	body := `{"schemaVersion":2,"capabilityVerified":false,"participant":{"sourceKind":"builder","id":"00000000-0000-4000-8000-000000000003","subjectId":"GUIDAAAAAAAAAAAAAAAAAAAAAAAAAAAA","capabilityVerified":false,"sources":[]}}`
	return &http.Response{StatusCode: 200, Header: http.Header{}, Request: r, Body: io.NopCloser(strings.NewReader(body))}, nil
}
func TestHelpParticipantDetailKeepsOneCandidateAndBasis(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "uninitialized")
	store, err := NewStore(dir, "https://public.invalid")
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: dir, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{HTTPClient: &http.Client{Transport: helpDetailTransport{}}})
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	value, err := NewNativeHelp(runtime).Call(context.Background(), "galaxy_help_query", map[string]any{"requests": []any{map[string]any{"requestId": "00000000-0000-4000-8000-000000000001", "kind": "participant-v2", "input": map[string]any{"sourceKind": "builder", "id": "00000000-0000-4000-8000-000000000003"}}}})
	if err != nil {
		t.Fatal(err)
	}
	result := psObject(trustArray(psObject(value)["results"])[0])
	data := psObject(result["data"])
	if data["participant"] == nil || len(trustArray(result["basis"])) != 1 {
		t.Fatal("candidate or basis missing", result)
	}
	if _, ok := data["items"]; ok {
		t.Fatal("detail duplicated candidate", data)
	}
}

func TestHelpMCPViewPreservesBusinessAndSourceFieldsNamedPrepareInput(t *testing.T) {
	source := map[string]any{"prepareInput": map[string]any{"payloadJson": "source text"}}
	query := map[string]any{"session": map[string]any{"id": "s", "queries": []any{}}, "results": []any{map[string]any{"data": source}}}
	projected := helpMCPView("galaxy_help_query", query).(map[string]any)
	result := projected["results"].([]any)[0].(map[string]any)["data"].(map[string]any)
	if result["prepareInput"].(map[string]any)["payloadJson"] != "source text" {
		t.Fatal("external source changed")
	}
	payload := map[string]any{"prepareInput": map[string]any{"payloadJson": "business text"}}
	preview := map[string]any{"payload": payload, "prepareInput": map[string]any{"payloadJson": "duplicate bytes"}}
	action := helpMCPView("galaxy_help_action_preview", preview).(map[string]any)
	if action["payload"].(map[string]any)["prepareInput"].(map[string]any)["payloadJson"] != "business text" {
		t.Fatal("business payload changed")
	}
	if _, ok := action["prepareInput"]; ok {
		t.Fatal("duplicate preview bytes retained")
	}
	review := map[string]any{"preview": map[string]any{"preview": preview}}
	projectedReview := helpMCPView("galaxy_help_execute_action", review).(map[string]any)["preview"].(map[string]any)["preview"].(map[string]any)
	if projectedReview["payload"].(map[string]any)["prepareInput"].(map[string]any)["payloadJson"] != "business text" {
		t.Fatal("review payload changed")
	}
}
