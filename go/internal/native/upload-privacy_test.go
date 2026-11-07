package native

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestUploadPrivacyAndProjectionMatchOriginalJavaScript(t *testing.T) {
	rawCases := []byte(`[
 {"current":null,"selection":{"level":"work-content"}},
 {"current":{"level":"conversation-archive","revision":4,"includeFullConversations":true,"sessionIds":[" a ",null,7,"a","\ufeffb\ufeff",""]},"selection":{"level":"conversation-archive","sessionIds":["b","a"]}},
 {"current":{"level":"conversation-archive","revision":2,"includeFullConversations":true,"sessionIds":["one"]},"selection":{"level":"history-overview"}},
 {"current":{"level":"work-content","revision":1.5,"updatedAt":""},"selection":{"level":"history-overview","includeFullConversations":true}},
 {"current":{"level":"conversation-archive","revision":7,"includeFullConversations":false,"sessionIds":[]},"selection":{"level":"conversation-archive","includeFullConversations":true,"sessionIds":[]}},
 {"current":{"level":"work-content","revision":9},"selection":{"level":"conversation-archive","includeFullConversations":true,"sessionIds":[" one ","one"]}}
 ]`)
	raw, e := os.ReadFile(filepath.Join("testdata", "contracts", "upload-privacy-v1.json"))
	if e != nil {
		t.Fatal(e)
	}
	var expected []map[string]any
	if e = json.Unmarshal(raw, &expected); e != nil {
		t.Fatal(e)
	}
	var cases []struct {
		Current   any                    `json:"current"`
		Selection UploadPrivacySelection `json:"selection"`
	}
	if e = json.Unmarshal(rawCases, &cases); e != nil {
		t.Fatal(e)
	}
	for i, value := range cases {
		current := NormalizeUploadPrivacy(value.Current)
		selected, e := SelectUploadPrivacy(current, value.Selection, "2033-05-18T03:33:20.000Z")
		if expected[i]["error"] != nil {
			if e == nil || e.Error() != expected[i]["error"] {
				t.Fatalf("selection error changed: %v %v", e, expected[i])
			}
			continue
		}
		if e != nil {
			t.Fatal(e)
		}
		same(t, expected[i], map[string]any{"current": current, "selected": selected})
	}
	store := materialStore(t)
	// Preserve the original synthetic work-history database and its JS projection bytes.
	database, e := os.ReadFile(filepath.Join("testdata", "legacy-upload", "history.sqlite"))
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(store.Directory, "work-history", "history.sqlite")
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, database, 0600); e != nil {
		t.Fatal(e)
	}
	raw, e = os.ReadFile(filepath.Join("testdata", "legacy-upload", "projections.json"))
	if e != nil {
		t.Fatal(e)
	}
	var fixture map[string]any
	if e = json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e)
	}
	record, e := store.WorkExport(context.Background(), WorkQuery{WorkID: fixture["workId"].(string)})
	if e != nil {
		t.Fatal(e)
	}
	for i, level := range []string{"local-only", "history-overview", "work-content", "conversation-archive"} {
		projected, e := ProjectWorkForUpload(NormalizeUploadPrivacy(map[string]any{"level": level}), record.(map[string]any))
		if e != nil {
			t.Fatal(e)
		}
		same(t, fixture["projections"].([]any)[i], projected)
	}
}

func TestUploadPrivacyReviewedPersistenceKeepsLocalAndAdoptedOwnersSeparate(t *testing.T) {
	ctx := context.Background()
	store := materialStore(t)
	configuration := Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}
	rt, e := NewRuntime(store, configuration, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	path := filepath.Join(store.Directory, "galaxy-local-state.json")
	if e = os.WriteFile(path, []byte(`{"custom":{"retained":true},"cases":[{"keep":true}],"auditEvents":[],"uploadPrivacy":{"level":"history-overview","revision":0}}`), 0600); e != nil {
		t.Fatal(e)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = rt.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: "work-content"}, &scope); e != nil {
		t.Fatal(e)
	}
	var state map[string]any
	if _, e = readJSON(path, &state); e != nil {
		t.Fatal(e)
	}
	if state["custom"].(map[string]any)["retained"] != true || len(state["cases"].([]any)) != 1 || len(state["auditEvents"].([]any)) != 1 {
		t.Fatal("privacy write changed unrelated local material")
	}
	localBefore, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	compareOriginal := func(owner string, view any) {
		t.Helper()
		raw, err := os.ReadFile(filepath.Join("testdata", "legacy-upload", owner+".json"))
		if err != nil {
			t.Fatal(err)
		}
		var expected map[string]any
		if err = json.Unmarshal(raw, &expected); err != nil {
			t.Fatal(err)
		}
		actualBytes, err := json.Marshal(view)
		if err != nil {
			t.Fatal(err)
		}
		var actual map[string]any
		if err = json.Unmarshal(actualBytes, &actual); err != nil {
			t.Fatal(err)
		}
		stamp, ok := actual["settings"].(map[string]any)["updatedAt"].(string)
		if !ok {
			t.Fatal("missing preference timestamp")
		}
		if _, err = time.Parse(time.RFC3339Nano, stamp); err != nil {
			t.Fatal(err)
		}
		expected["settings"].(map[string]any)["updatedAt"] = stamp
		same(t, expected, actual)
	}
	view, e := rt.GetUploadPrivacy(ctx)
	if e != nil {
		t.Fatal(e)
	}
	compareOriginal(scope.Owner, view)
	activePath := connectionRecordPath(store.Directory, "native-active:"+store.Endpoint)
	if e = os.MkdirAll(filepath.Dir(activePath), 0700); e != nil {
		t.Fatal(e)
	}
	if e = writeJSON(activePath, map[string]any{"subjectId": "adopted-owner", "deviceId": "isolated-device"}); e != nil {
		t.Fatal(e)
	}
	adopted, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	// A previously saved level 2 remains effective for an adopted identity.
	if e = writeJSON(filepath.Join(store.Directory, "galaxy-upload-privacy.json"), map[string]any{
		"version":    1,
		"identities": map[string]any{adopted.Owner: NormalizeUploadPrivacy(map[string]any{"level": "history-overview"})},
	}); e != nil {
		t.Fatal(e)
	}
	if _, e = rt.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: "local-only"}, &adopted); e != nil {
		t.Fatal(e)
	}
	localAfter, e := os.ReadFile(path)
	if e != nil || string(localBefore) != string(localAfter) {
		t.Fatal("adopted preference overwrote local owner's state")
	}
	view, e = rt.GetUploadPrivacy(ctx)
	if e != nil {
		t.Fatal(e)
	}
	compareOriginal(adopted.Owner, view)
	if _, e = rt.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: "conversation-archive"}, &scope); e == nil {
		t.Fatal("stale owner choice overwrote adopted preference")
	}
}

func TestUploadPrivacyDispatchFollowsSavedScope(t *testing.T) {
	ctx := context.Background()
	store := materialStore(t)
	runtime := commandRuntime(t, store)
	selection, err := runtime.connection.selection(ctx)
	if err != nil {
		t.Fatal(err)
	}
	lease := connectionLease{selection: selection}
	path := filepath.Join(store.Directory, "galaxy-local-state.json")
	cases := []struct {
		name, level, kind, session string
		includeFull, allowed       bool
	}{
		{name: "unset blocks metadata", kind: "history-metadata"},
		{name: "level 2 allows metadata", level: "history-overview", kind: "history-metadata", allowed: true},
		{name: "level 2 blocks summaries", level: "history-overview", kind: "work-summary"},
		{name: "level 3 allows summaries", level: "work-content", kind: "work-summary", allowed: true},
		{name: "level 3 blocks full sessions", level: "work-content", kind: "full-conversation", session: "chosen"},
		{name: "level 4 alone blocks full sessions", level: "conversation-archive", kind: "full-conversation", session: "chosen"},
		{name: "level 4 allows selected session", level: "conversation-archive", kind: "full-conversation", session: "chosen", includeFull: true, allowed: true},
		{name: "level 4 blocks other sessions", level: "conversation-archive", kind: "full-conversation", session: "other", includeFull: true},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			state := map[string]any{}
			if test.level != "" {
				state["uploadPrivacy"] = map[string]any{"level": test.level, "includeFullConversations": test.includeFull, "sessionIds": []string{"chosen"}}
			}
			if err := writeJSON(path, state); err != nil {
				t.Fatal(err)
			}
			options := ConnectionLocalUpload{DataTypes: []string{test.kind}, SessionID: test.session}
			err := runtime.connection.checkUpload(ctx, "/v2/example", map[string]any{}, "POST", lease, options)
			if test.allowed && err != nil || !test.allowed && fault.Code(err) != "local_upload_type_not_allowed" {
				t.Fatalf("upload allowed = %t, got %v", test.allowed, err)
			}
		})
	}
}
