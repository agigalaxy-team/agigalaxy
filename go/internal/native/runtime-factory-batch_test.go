package native

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// One combined factory path, rather than another catalog-size assertion or a
// repeat of the existing Hub/worker/identity/App suites. The runtime transport
// rejects every HTTP request; only the explicit page subtest uses loopback.
func TestRuntimeFactoryHelpWebPreviewPanelLocalBatch(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	store, _ := fixture(t)
	rt := interactionRuntime(t, store)
	entry, e := NewRuntimeToolServer(store, rt, interactionArtifact(t))
	if e != nil {
		t.Fatal(e)
	}
	defer entry.Close()
	ct, st := mcp.NewInMemoryTransports()
	ss, e := entry.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "native-current-batch-no-network", Version: "1"}, nil)
	cs, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	listed, e := cs.ListTools(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	tools := map[string]*mcp.Tool{}
	for _, tool := range listed.Tools {
		if _, duplicate := tools[tool.Name]; duplicate {
			t.Fatalf("duplicate actual factory registration: %s", tool.Name)
		}
		tools[tool.Name] = tool
	}
	expected := []string{
		"galaxy_help_start", "galaxy_help_get", "galaxy_help_query", "galaxy_help_compose", "galaxy_help_select", "galaxy_help_pause", "galaxy_help_publish", "galaxy_help_reconcile", "galaxy_help_refresh", "galaxy_help_return", "galaxy_help_forget", "galaxy_help_review", "galaxy_help_prepare_action", "galaxy_help_action_preview", "galaxy_help_execute_action", "galaxy_help_reconcile_action",
		"galaxy_identity_web_connect", "galaxy_identity_web_connect_status", "galaxy_local_work_upload_preview", "galaxy_local_archive_upload_preview",
		"galaxy_panel", "galaxy_panel_refresh", "galaxy_panel_open", "galaxy_panel_return", "galaxy_panel_draft_save", "galaxy_panel_reply_draft_save", "galaxy_panel_message_send", "galaxy_panel_select", "galaxy_panel_action_prepare", "galaxy_panel_action_preview", "galaxy_panel_action_execute", "galaxy_panel_action_reconcile", "galaxy_panel_finish", "galaxy_host_view_state",
	}
	for _, name := range expected {
		if tools[name] == nil || tools[name].InputSchema == nil {
			t.Fatalf("actual Runtime factory missing %s", name)
		}
	}
	call := func(name string, input map[string]any) (*mcp.CallToolResult, map[string]any) {
		t.Helper()
		result, e := cs.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: input})
		if e != nil || result == nil || result.IsError {
			t.Fatalf("%s: %v %#v", name, e, result)
		}
		if result.StructuredContent != nil {
			return result, psObject(result.StructuredContent)
		}
		if len(result.Content) != 1 {
			t.Fatalf("%s has no JSON result", name)
		}
		content, ok := result.Content[0].(*mcp.TextContent)
		if !ok {
			t.Fatalf("%s result is not text", name)
		}
		var value map[string]any
		if e = protocol.Decode([]byte(content.Text), &value); e != nil {
			t.Fatal(e)
		}
		return result, value
	}
	_, created := call("galaxy_help_start", map[string]any{"localTaskRef": "original synthetic local conversation"})
	sessionID := text(created["id"])
	if !controlUUID(sessionID) || psInt(created["revision"]) != 1 || created["localOnly"] != true {
		t.Fatal(created)
	}
	_, read := call("galaxy_help_get", map[string]any{"sessionId": sessionID})
	if read["id"] != sessionID || read["localTaskRef"] != created["localTaskRef"] {
		t.Fatal(read)
	}
	_, paused := call("galaxy_help_pause", map[string]any{"sessionId": sessionID, "expectedRevision": read["revision"], "state": "paused"})
	if paused["pauseState"] != "paused" || psInt(paused["revision"]) != 2 {
		t.Fatal(paused)
	}
	_, returned := call("galaxy_help_return", map[string]any{"sessionId": sessionID, "expectedRevision": paused["revision"]})
	saved := psObject(returned["session"])
	if saved["id"] != sessionID || saved["pauseState"] != "returned" || psInt(saved["revision"]) != 3 || returned["state"] != "no-acknowledged-task" || returned["remoteOperationsCanceled"] != false {
		t.Fatal(returned)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	scopeJSON, _ := json.Marshal([]string{store.Endpoint, scope.Owner})
	file := filepath.Join(store.Directory, "help-v2", identity.Digest(scopeJSON), sessionID+".json")
	var disk map[string]any
	if ok, e := readJSON(file, &disk); e != nil || !ok || disk["id"] != sessionID || disk["subjectId"] != scope.Owner || disk["pauseState"] != "returned" || disk["cloudSync"] != "off" {
		t.Fatalf("original local Help record not saved: %v %#v", e, disk)
	}
	// Exercise this factory's new Panel consumer with the same Help instance.
	// Unsent draft content must remain only in the component metadata.
	_, panel := call("galaxy_panel", map[string]any{"helpSessionId": sessionID})
	viewID := text(panel["viewId"])
	if !controlUUID(viewID) {
		t.Fatal(panel)
	}
	const draft = "synthetic device-only draft must not enter model context"
	result, model := call("galaxy_panel_draft_save", map[string]any{"viewId": viewID, "expectedRevision": 0, "draft": draft})
	visible, e := protocol.Encode(map[string]any{"content": result.Content, "structuredContent": result.StructuredContent})
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(visible), draft) || psObject(model["draft"])["hasContent"] != true {
		t.Fatalf("draft entered model-visible result: %s", visible)
	}
	if psObject(psObject(result.Meta["galaxyPanel"])["draft"])["text"] != draft {
		t.Fatal("component lost the actual device-only draft")
	}
	// Registering the real web tools above is separate from the following
	// bounded page-only check: no Prepare, real website or device approval.
	t.Run("original-web-page-errors-and-cancel-headless", func(t *testing.T) {
		op, release, lease, e := rt.handoffLease(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer release()
		host := NewNativeWebHandoff(rt)
		var loopback string
		host.OpenBrowser = func(_ context.Context, url string) (map[string]any, error) {
			loopback = url
			return map[string]any{"launched": false, "capturedForIndependentHeadless": true}, nil
		}
		const handoff = "00000000-0000-4000-8000-000000000071"
		bridge := &webIdentityBridge{host: host, lease: lease, id: handoff, navigationID: "00000000-0000-4000-8000-000000000072", target: "/app/account", state: "ready", expires: rt.connection.now().Unix() + 180, scopes: []string{"binding"}, context: map[string]any{"endpoint": store.Endpoint, "website": rt.config.Website, "subjectId": scope.Owner, "scopes": []any{"binding"}}}
		// Public UI fixture only. No controller proof is supplied or approved.
		if e = bridge.start(); e != nil {
			t.Fatal(e)
		}
		defer bridge.Close()
		if _, e = host.OpenBrowser(op, bridge.URL()); e != nil {
			t.Fatal(e)
		}
		if !strings.HasPrefix(loopback, "http://127.0.0.1:") {
			t.Fatal(loopback)
		}
		_, source, _, _ := goruntime.Caller(0)
		root := filepath.Clean(filepath.Join(filepath.Dir(source), "../../.."))
		script := `import {chromium} from 'playwright';const browser=await chromium.launch({headless:true});try{const context=await browser.newContext();await context.route('https://selected.invalid/**',route=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><title>Isolated cancellation target; no website connection</title>'}));const page=await context.newPage();await page.goto(process.argv[1]);if(await page.title()!=='银河 · 接续已有身份')throw Error('original page title missing');if(!await page.getByRole('button',{name:'打开官网并接续同一身份',exact:true}).isVisible())throw Error('original handoff button missing');const response=await page.evaluate(async()=>{const r=await fetch(location.pathname+'/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({unexpected:true})});return{status:r.status,body:await r.json()};});if(response.status!==409||response.body.error!=='web_identity_message_invalid')throw Error('actual original invalid packet response changed');const opening=page.waitForEvent('popup');await page.getByRole('button',{name:'打开官网并接续同一身份',exact:true}).click();const popup=await opening;await popup.waitForLoadState('domcontentloaded');await popup.close();await page.waitForFunction(()=>document.getElementById('progress').textContent.includes('本次传输已停止'));const state=await page.evaluate(async()=>{const r=await fetch(location.pathname+'/state');return r.json();});if(state.state!=='canceled'||state.operationId!==null||state.deviceAuthorizationVerified||state.webConnectionReported)throw Error('cancel inferred remote device authorization');await context.close();console.log(JSON.stringify({headless:true,state:state.state,handoffId:state.handoffId}));}finally{await browser.close();}`
		command := exec.CommandContext(ctx, "node", "--input-type=module", "-e", script, loopback)
		command.Dir = root
		bytes, e := command.CombinedOutput()
		if e != nil {
			t.Fatalf("isolated original page: %v %s", e, bytes)
		}
		status := bridge.Status()
		if status["state"] != "canceled" || status["handoffId"] != handoff || status["operationId"] != nil || status["deviceAuthorizationVerified"] != false {
			t.Fatal(status)
		}
		var retained map[string]any
		if ok, e := readJSON(connectionRecordPath(store.Directory, "web-identity-handoff:"+handoff), &retained); e != nil || !ok || retained["state"] != "canceled" {
			t.Fatalf("original handoff journal lost on cancel: %v %#v", e, retained)
		}
	})
	entry.Close()
	closed, e := cs.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_help_get", Arguments: map[string]any{"sessionId": sessionID}})
	if e != nil || closed == nil || !closed.IsError {
		t.Fatal("factory Close left Help active", e, closed)
	}
	if _, e = os.Stat(file); e != nil {
		t.Fatal("Close deleted the persisted original Help record", e)
	}
}
