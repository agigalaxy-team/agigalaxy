package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type referenceProfileTransport struct {
	next   http.RoundTripper
	calls  atomic.Int32
	active atomic.Int32
	max    atomic.Int32
}

func (f *referenceProfileTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Path != "/v1/history/query" {
		return f.next.RoundTrip(request)
	}
	f.calls.Add(1)
	active := f.active.Add(1)
	defer f.active.Add(-1)
	for old := f.max.Load(); active > old; old = f.max.Load() {
		if f.max.CompareAndSwap(old, active) {
			break
		}
	}
	time.Sleep(time.Millisecond)
	raw, _ := io.ReadAll(request.Body)
	var input map[string]any
	_ = protocol.Decode(raw, &input)
	value := map[string]any{"selfDeclared": map[string]any{}, "accountName": "not-a-profile-fallback"}
	status := 200
	id := text(input["subjectId"])
	switch {
	case strings.HasSuffix(id, strings.Repeat("Z", 28)):
		status = 403
		value = map[string]any{"error": "profile_unavailable"}
	case strings.HasSuffix(id, strings.Repeat("Y", 28)):
		value["selfDeclared"] = map[string]any{"displayName": " \ufeff Current name  "}
		value["selfDeclaredReadExpiresAt"] = nil
	case strings.HasSuffix(id, strings.Repeat("X", 28)):
		value["selfDeclared"] = map[string]any{"displayName": "Self"}
		value["selfDeclaredReadExpiresAt"] = int64(2000000010)
	}
	return &http.Response{StatusCode: status, Header: http.Header{}, Request: request, Body: io.NopCloser(strings.NewReader(hostJSONString(value)))}, nil
}
func TestNativeReferenceReadOriginalNamesAndReceiptTool(t *testing.T) {
	ctx := context.Background()
	store, meta, transport := connectionServiceFixture(t)
	profiles := &referenceProfileTransport{next: transport}
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: profiles}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	server := mcp.NewServer(&mcp.Implementation{Name: "references", Version: "1"}, nil)
	registerNativeReferenceTools(server, &toolRuntime{store: store}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "references", Version: "1"}, nil)
	session, e := client.Connect(ctx, ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	receipt := materialCall(t, session, "galaxy_native_receipt_status", meta.Operation, false)
	if receipt["state"] != "acknowledged" || transport.count() != 2 {
		t.Fatal("read-only original receipt created ordinary session", receipt, transport.count())
	}
	if snapshot, e := runtime.connection.Snapshot(ctx); e != nil || snapshot != nil {
		t.Fatal("receipt tool connected", e)
	}
	if _, e = runtime.Restore(ctx); e != nil {
		t.Fatal(e)
	}
	owner, e := store.Owner(ctx)
	if e != nil {
		t.Fatal(e)
	}
	ids := []string{owner, "GUID" + strings.Repeat("Z", 28), owner, "GUID" + strings.Repeat("Y", 28), "GUID" + strings.Repeat("X", 28)}
	inputPath := filepath.Join(t.TempDir(), "subjects.json")
	if e = writeJSON(inputPath, ids); e != nil {
		t.Fatal(e)
	}
	original := initializationNode(t, `import {readFile} from 'node:fs/promises';import {readProfileDisplayNames} from './packages/galaxy-client/src/accounts/profile-display-names.mjs';const ids=JSON.parse(await readFile(process.argv[1],'utf8'));console.log(JSON.stringify({items:await readProfileDisplayNames(async(path,{subjectId})=>{if(path!=='/v1/history/query')throw Error('wrong source');if(subjectId.endsWith('Z'.repeat(28)))throw Object.assign(Error('profile_unavailable'),{code:'profile_unavailable'});if(subjectId.endsWith('Y'.repeat(28)))return{selfDeclared:{displayName:' \ufeff Current name  '},selfDeclaredReadExpiresAt:null};if(subjectId.endsWith('X'.repeat(28)))return{selfDeclared:{displayName:'Self'},selfDeclaredReadExpiresAt:2000000010};return{selfDeclared:{},accountName:'not-a-profile-fallback'};},ids)}));`, inputPath)
	result := materialCall(t, session, "galaxy_profile_names", map[string]any{"subjectIds": ids}, false)
	if !connectionEqual(result, original) || profiles.calls.Load() != 4 || profiles.max.Load() > 4 {
		t.Fatal("original names semantics differ", result, original, profiles.calls.Load())
	}
	materialCall(t, session, "galaxy_native_receipt_status", map[string]any{"kind": "chat-message", "snapshotId": meta.Operation.SnapshotID, "versionId": meta.Operation.VersionID, "requestHash": meta.Operation.RequestHash}, true)
	materialCall(t, session, "galaxy_profile_names", map[string]any{"subjectIds": nil}, true)
}
