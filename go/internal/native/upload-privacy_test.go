package native

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestUploadPrivacyAndProjectionMatchOriginalJavaScript(t *testing.T) {
	_, file, _, _ := runtime.Caller(0)
	root := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(file), "../../..")))
	script := `import {normalizeUploadPrivacy,selectUploadPrivacy} from 'file:///` + root + `/packages/galaxy-core/src/upload-privacy.mjs';let raw='';for await(const part of process.stdin)raw+=part;const cases=JSON.parse(raw);console.log(JSON.stringify(cases.map(x=>{try{const current=normalizeUploadPrivacy(x.current);return {current,selected:selectUploadPrivacy(current,x.selection,'2033-05-18T03:33:20.000Z')}}catch(e){return {error:e.code}}})));`
	rawCases := []byte(`[
 {"current":null,"selection":{"level":"work-content"}},
 {"current":{"level":"conversation-archive","revision":4,"includeFullConversations":true,"sessionIds":[" a ",null,7,"a","\ufeffb\ufeff",""]},"selection":{"level":"conversation-archive","sessionIds":["b","a"]}},
 {"current":{"level":"conversation-archive","revision":2,"includeFullConversations":true,"sessionIds":["one"]},"selection":{"level":"history-overview"}},
 {"current":{"level":"work-content","revision":1.5,"updatedAt":""},"selection":{"level":"history-overview","includeFullConversations":true}},
 {"current":{"level":"conversation-archive","revision":7,"includeFullConversations":false,"sessionIds":[]},"selection":{"level":"conversation-archive","includeFullConversations":true,"sessionIds":[]}},
 {"current":{"level":"work-content","revision":9},"selection":{"level":"conversation-archive","includeFullConversations":true,"sessionIds":[" one ","one"]}}
 ]`)
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Stdin = bytes.NewReader(rawCases)
	raw, e := cmd.Output()
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
	program := `import {createLocalWorkHistory} from 'file:///` + root + `/packages/galaxy-core/src/work-history/index.mjs';import {projectWorkHistoryForUpload} from 'file:///` + root + `/packages/galaxy-core/src/upload-privacy.mjs';const history=createLocalWorkHistory({dataDirectory:process.argv[1]});await history.observeEnvironment({host:'opencode',sessionId:'opaque-session',facts:{host:'opencode',selectedModel:'local/model',tools:['editor','mcp:source','ignored/path'],configuredModel:'private-choice',cwd:'private/path'}});const note=await history.recordNote({host:'opencode',sessionId:'opaque-session',text:'Isolated model report',sourceKind:'model-report'});const record=await history.exportWork({workId:note.workId});console.log(JSON.stringify({workId:note.workId,projections:['local-only','history-overview','work-content','conversation-archive'].map(level=>projectWorkHistoryForUpload({level},record))}));`
	cmd = exec.Command("node", "--input-type=module", "-e", program, store.Directory)
	raw, e = cmd.Output()
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
	_, file, _, _ := runtime.Caller(0)
	root := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(file), "../../..")))
	original := func(owner string) any {
		script := `import {getLocalUploadPrivacy} from 'file:///` + root + `/packages/galaxy-core/src/application/local-operations.mjs';console.log(JSON.stringify(await getLocalUploadPrivacy(process.argv[1],{getIdentity:()=>({id:process.argv[2]})})));`
		cmd := exec.Command("node", "--input-type=module", "-e", script, store.Directory, owner)
		raw, e := cmd.Output()
		if e != nil {
			t.Fatal(e)
		}
		var value any
		if e = json.Unmarshal(raw, &value); e != nil {
			t.Fatal(e)
		}
		return value
	}
	view, e := rt.GetUploadPrivacy(ctx)
	if e != nil {
		t.Fatal(e)
	}
	same(t, original(scope.Owner), view)
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
	same(t, original(adopted.Owner), view)
	if _, e = rt.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: "conversation-archive"}, &scope); e == nil {
		t.Fatal("stale owner choice overwrote adopted preference")
	}
}
