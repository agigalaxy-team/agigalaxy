package native

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type connectionFixtureMetadata struct {
	Configuration Configuration    `json:"configuration"`
	Origin        string           `json:"origin"`
	Now           int64            `json:"now"`
	Operation     ReceiptOperation `json:"operation"`
}
type connectionTestTransport struct {
	origin        *url.URL
	mu            sync.Mutex
	paths         []string
	authorization []bool
	hook          func(*http.Response, *http.Request) (*http.Response, error)
}

func (t *connectionTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.paths = append(t.paths, req.URL.Path)
	t.authorization = append(t.authorization, req.Header.Get("Authorization") != "")
	hook := t.hook
	t.mu.Unlock()
	copy := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = t.origin.Scheme
	u.Host = t.origin.Host
	copy.URL = &u
	copy.Host = t.origin.Host
	response, e := http.DefaultTransport.RoundTrip(copy)
	if e != nil {
		return nil, e
	}
	if hook != nil {
		return hook(response, req)
	}
	return response, nil
}
func (t *connectionTestTransport) count() int { t.mu.Lock(); defer t.mu.Unlock(); return len(t.paths) }
func (t *connectionTestTransport) setHook(hook func(*http.Response, *http.Request) (*http.Response, error)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.hook = hook
}
func connectionServiceFixture(t *testing.T) (*Store, connectionFixtureMetadata, *connectionTestTransport) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(file), "../../..")))
	dir := t.TempDir()
	script := `
import {receiptStatusFixture} from 'file:///` + root + `/packages/galaxy-official/test/receipt-status-workflow.mjs';
import {createNativeRuntime} from 'file:///` + root + `/packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {createHelpSearchClient} from 'file:///` + root + `/packages/galaxy-web/src/features/help-search/help-search-client.mjs';
import {createChoiceSyncClient} from 'file:///` + root + `/packages/galaxy-web/src/features/choice-sync/choice-sync-client.mjs';
import {choicePutIntent} from 'file:///` + root + `/packages/galaxy-official/src/shared/choice-snapshot-schema-v2.mjs';
import {digest} from 'file:///` + root + `/packages/galaxy-official/src/shared/digest.mjs';
import {trustCanonical as canonicalize} from 'file:///` + root + `/packages/galaxy-official/src/shared/trust-package-crypto.mjs';
import {randomUUID} from 'node:crypto';import {writeFile} from 'node:fs/promises';
const t=await receiptStatusFixture(),dir=process.argv[1];let drop=false;
const transport=async(url,options)=>{const response=await t.transport(url,options);if(drop&&new URL(url).pathname==='/v2/choice-snapshots/put'){drop=false;throw Error('isolated lost ACK');}return response;};
const config={dataDirectory:dir,endpoint:t.f.access.endpoint,website:'https://galaxy.example.org',trustedKeys:t.trustedKeys,fetch:transport,now:t.now,autoResumePrivateSync:false};
const native=await createNativeRuntime(config);await native.initialize({profile:'minimal'},{confirmed:true});await native.connect({confirmed:true});
const subjectId=(await native.status()).identity,facade={api:native.api,status:async()=>{const s=await native.status();return {...s,identity:{subjectId:s.identity}};},getLocal:name=>native.store.get('test-choice:'+subjectId+':'+name),putLocal:(name,value)=>native.store.put('test-choice:'+subjectId+':'+name,value)};
const search=createHelpSearchClient(facade,{authenticated:true,subjectId}),cloud=createChoiceSyncClient(facade,{subjectId}),page=await search.query({type:'history',query:{query:'Retained receipt source'}}),candidate=search.candidateKey(page.items[0]),snapshotId=randomUUID();
await search.saveChoice({id:snapshotId,expectedVersion:0,localTaskRef:'Isolated original operation',visibleRationale:'Isolated retained receipt',rationaleAuthor:'user',candidateKeys:[candidate],selectedKeys:[candidate],resultRefs:[]});await cloud.savePreference({endpoint:config.endpoint,expectedRevision:0,enabled:true,snapshotIds:[snapshotId]});drop=true;try{await cloud.sync(snapshotId);throw Error('expected lost ACK');}catch(e){if(!String(e.message).includes('lost ACK'))throw e;}
const pending=(await cloud.localState()).pending[snapshotId],operation={kind:'choice-snapshot',snapshotId,versionId:pending.versionId,requestHash:digest(canonicalize(choicePutIntent(pending)))};
search.close();cloud.close();await native.close();
await writeFile(dir+'/connection-fixture.json',JSON.stringify({configuration:{version:2,endpoint:config.endpoint,website:config.website,dataDirectory:dir,trustedKeys:Object.fromEntries(t.trustedKeys)},origin:'http://127.0.0.1:'+t.api.address().port,now:t.now(),operation}));
process.stdout.write('ready\n');process.stdin.resume();process.stdin.on('end',async()=>{await t.close();});
`
	cmd := exec.Command("node", "--input-type=module", "-e", script, dir)
	cmd.Dir = root
	stdin, e := cmd.StdinPipe()
	if e != nil {
		t.Fatal(e)
	}
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		stdin.Close()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cmd.Process.Kill()
			<-done
		}
	})
	line, e := bufio.NewReader(stdout).ReadString('\n')
	if e != nil || line != "ready\n" {
		t.Fatalf("original service fixture failed: %v %s %s", e, line, stderr.String())
	}
	raw, e := os.ReadFile(filepath.Join(dir, "connection-fixture.json"))
	if e != nil {
		t.Fatal(e)
	}
	var metadata connectionFixtureMetadata
	if e = json.Unmarshal(raw, &metadata); e != nil {
		t.Fatal(e)
	}
	store, e := NewStore(dir, metadata.Configuration.Endpoint)
	if e != nil {
		t.Fatal(e)
	}
	origin, _ := url.Parse(metadata.Origin)
	return store, metadata, &connectionTestTransport{origin: origin}
}

func TestConnectionRestoresOriginalJSChoiceAndRetainedReceipt(t *testing.T) {
	store, meta, transport := connectionServiceFixture(t)
	ctx := context.Background()
	now := time.Unix(meta.Now, 0)
	connection, e := NewConnection(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return now }})
	if e != nil {
		t.Fatal(e)
	}
	defer connection.Close()
	selectionPath := connectionRecordPath(store.Directory, "native-selection:"+store.Endpoint)
	selectionBefore, e := os.ReadFile(selectionPath)
	if e != nil {
		t.Fatal(e)
	}
	snapshot, e := connection.Snapshot(ctx)
	if e != nil || snapshot != nil {
		t.Fatal("new Go runtime claimed connected")
	}
	receipt, e := connection.QueryReceipt(ctx, meta.Operation)
	if e != nil {
		t.Fatal(e)
	}
	if receipt["state"] != "acknowledged" || receipt["currentAccessGranted"] != false || receipt["contentReturned"] != false {
		t.Fatal("original receipt not retained")
	}
	if transport.count() != 2 {
		t.Fatalf("receipt created ordinary connection: %v", transport.paths)
	}
	for _, auth := range transport.authorization {
		if auth {
			t.Fatal("receipt used ordinary credential")
		}
	}
	snapshot, e = connection.Restore(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if snapshot == nil || snapshot.SubjectID == "" || snapshot.BindingID == "" || snapshot.Control["epoch"] == nil {
		t.Fatal("original device restore failed")
	}
	selectionAfter, e := os.ReadFile(selectionPath)
	if e != nil || string(selectionAfter) != string(selectionBefore) {
		t.Fatal("restore rewrote original selection")
	}
	if got, e := connection.Call(ctx, "/v2/identity/"+snapshot.SubjectID+"/control", nil, ConnectionCallOptions{Method: "GET"}); e != nil || got["subjectId"] != snapshot.SubjectID {
		t.Fatalf("authenticated call: %v", e)
	}
	start := transport.count()
	if _, e = connection.Call(ctx, "/v2/context/grants", map[string]any{"materials": []any{map[string]any{"text": "private work"}}}, ConnectionCallOptions{}); fault.Code(e) != "local_upload_type_not_allowed" {
		t.Fatalf("upload privacy lost: %v", e)
	}
	if transport.count() != start {
		t.Fatal("excluded local material sent")
	}
	if _, e = connection.Call(ctx, "https://other.invalid/v1/data", nil, ConnectionCallOptions{}); fault.Code(e) != "native_api_path_invalid" {
		t.Fatalf("caller changed authority: %v", e)
	}
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v1/isolated-unknown" {
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	start = transport.count()
	_, e = connection.Call(ctx, "/v1/isolated-unknown", map[string]any{"operationId": meta.Operation.VersionID}, ConnectionCallOptions{})
	var unknown *ConnectionRequestError
	if !errors.As(e, &unknown) || unknown.Outcome != "unknown" || transport.count() != start+1 {
		t.Fatalf("unknown request replayed or misreported: %v", e)
	}
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v1/isolated-rejected" {
			response.Body.Close()
			response.StatusCode = 403
			response.Body = io.NopCloser(strings.NewReader(`{"error":"access_denied"}`))
			response.ContentLength = -1
		}
		return response, nil
	})
	_, e = connection.Call(ctx, "/v1/isolated-rejected", map[string]any{}, ConnectionCallOptions{})
	var rejected *ConnectionHTTPError
	if !errors.As(e, &rejected) || rejected.Code != "access_denied" || rejected.Outcome != "rejected" {
		t.Fatalf("explicit rejection masked: %v", e)
	}
	if current, e := connection.Snapshot(ctx); e != nil || current != nil {
		t.Fatal("explicit revocation retained ordinary credential")
	}
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/receipt-status/challenges" {
			connection.Disconnect()
		}
		return response, nil
	})
	start = transport.count()
	if _, e = connection.QueryReceipt(ctx, meta.Operation); fault.Code(e) != "receipt_status_authority_changed" {
		t.Fatalf("receipt lifecycle ABA accepted: %v", e)
	}
	if transport.count() != start+1 {
		t.Fatal("old receipt challenge signed after disconnect")
	}
	transport.setHook(nil)
	wrong := meta.Configuration
	wrong.Endpoint = meta.Origin
	if _, e = NewConnection(store, wrong, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}}); fault.Code(e) != "native_connection_configuration_invalid" {
		t.Fatal("test transport allowed HTTP production authority")
	}
	blockedConfig := meta.Configuration
	blockedConfig.TrustedKeys = map[string]Pin{}
	for id, pin := range meta.Configuration.TrustedKeys {
		deadline := meta.Now
		pin.TrustedUntil = &deadline
		blockedConfig.TrustedKeys[id] = pin
	}
	blocked, e := NewConnection(store, blockedConfig, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return now }})
	if e != nil {
		t.Fatal(e)
	}
	start = transport.count()
	if _, e = blocked.Restore(ctx); fault.Code(e) != "native_server_pin_invalid" {
		t.Fatalf("pin trust deadline ignored: %v", e)
	}
	if transport.count() != start+2 {
		t.Fatal("untrusted challenge signed")
	}
	blocked.Close()
	changing, e := NewConnection(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return now }})
	if e != nil {
		t.Fatal(e)
	}
	var mutationError error
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/binding-challenges" {
			mutationError = store.With(ctx, true, func(dir string) error {
				var record map[string]any
				if _, e := readJSON(selectionPath, &record); e != nil {
					return e
				}
				record["revision"] = integer(record["revision"]) + 1
				return writeJSON(selectionPath, record)
			})
		}
		return response, nil
	})
	start = transport.count()
	if _, e = changing.Restore(ctx); fault.Code(e) != "native_connection_selection_changed" || mutationError != nil {
		t.Fatalf("late selection accepted: %v %v", e, mutationError)
	}
	if transport.count() != start+2 {
		t.Fatal("old owner signed after selection changed")
	}
	changing.Close()
	transport.setHook(nil)
	connection.Close()
	if _, e = connection.Restore(ctx); fault.Code(e) != "native_runtime_closed" {
		t.Fatalf("closed connection restored: %v", e)
	}
}
func TestConnectionRejectsTrailingJSON(t *testing.T) {
	for _, raw := range []string{`{} true`, `{} trailing`, `null`, `[]`} {
		if _, e := connectionObject([]byte(raw)); e == nil {
			t.Fatalf("invalid response accepted: %s", raw)
		}
	}
	if _, e := connectionObject([]byte("{} \r\n")); e != nil {
		t.Fatal(e)
	}
}
