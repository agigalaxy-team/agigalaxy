package native

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type workUploadFixtureMetadata struct {
	connectionFixtureMetadata
	OperationID  string              `json:"operationId"`
	UnknownID    string              `json:"unknownId"`
	WorkID       string              `json:"workId"`
	TargetID     string              `json:"targetId"`
	DataJSON     string              `json:"dataJson"`
	Settings     map[string]any      `json:"settings"`
	PeerDeviceID string              `json:"peerDeviceId"`
	Authorize    func(string) string `json:"-"`
}

func workUploadServiceFixture(t *testing.T) (*Store, workUploadFixtureMetadata, *connectionTestTransport) {
	return workUploadServiceFixtureDatabase(t, "")
}
func workUploadServiceFixtureDatabase(t *testing.T, dsn string, identityPeer ...bool) (*Store, workUploadFixtureMetadata, *connectionTestTransport) {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(file), "../../..")))
	dir := t.TempDir()
	script := `
import {communityForumFixture} from 'file:///` + root + `/packages/galaxy-official/test/community-forum-fixture.mjs';
import {createNativeRuntime} from 'file:///` + root + `/packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';
import {browserScopes} from 'file:///` + root + `/packages/galaxy-official/src/browser-client.mjs';
import {createNativeWorkSync} from 'file:///` + root + `/packages/galaxy-edge-mcp/src/native-v2/work/sync.mjs';
import {createLocalWorkHistory} from 'file:///` + root + `/packages/galaxy-core/src/work-history/index.mjs';
import {projectWorkHistoryForUpload} from 'file:///` + root + `/packages/galaxy-core/src/upload-privacy.mjs';
import {signIdentityPayload,createDeviceMaterial} from 'file:///` + root + `/packages/galaxy-core/src/domain/identity-material.mjs';
import {randomUUID} from 'node:crypto';import {writeFile} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';
let database=null;if(process.argv[2]){const u=new URL(process.argv[2]);if(u.hostname!=='127.0.0.1'||!/^\/galaxy_go_test_[a-z0-9_]+$/.test(u.pathname))throw Error('isolated PostgreSQL only');const {default:pg}=await import('file:///` + root + `/packages/galaxy-official/node_modules/pg/lib/index.js');database=new pg.Pool({connectionString:u.href});database.close=()=>database.end();}
const f=await communityForumFixture({scopes:browserScopes,database}),dir=process.argv[1],endpoint=f.owner.access.endpoint,origin=f.origin;
const fetcher=(url,options)=>fetch(origin+new URL(url).pathname,options);
const native=await createNativeRuntime({dataDirectory:dir,endpoint,website:f.website,trustedKeys:f.owner.bindings.trustedKeys,fetch:fetcher,now:()=>f.clock.now,autoResumePrivateSync:false});await native.initialize({profile:'minimal'},{confirmed:true});await native.connect({confirmed:true});
const status=await native.status(),subjectId=status.identity,material=await native.store.get('device:'+subjectId+':'+status.connectionChoice.deviceId);
f.issuer.setAccount('isolated-native-work-upload');const begun=await native.api.call('/v1/identity/begin',{providerId:'forum-fixture'}),callback=await f.issuer.authorize(begun.authorizationUrl);const returned=await fetch(origin+callback.pathname+callback.search);if(!returned.ok)throw Error('isolated association callback failed');await returned.arrayBuffer();const preview=await native.api.call('/v1/identity/status',{id:begun.loginId});await native.api.call('/v1/identity/confirm',{id:begun.loginId,signed:await signIdentityPayload(preview.payloadJson,material.privateKey,{type:'galaxy-identity-link+jws'})});
const accounts=await native.api.call('/v2/account-archives/accounts',{}),targetId=accounts.accounts[0]?.accountId;if(!targetId)throw Error('isolated account unavailable');
let peerDeviceId=null;if(process.argv[3]==='identity-peer'){const peer=await createDeviceMaterial(),state=await native.api.call('/v2/identity/'+subjectId+'/control',undefined,{method:'GET',authenticated:false}),own=state.devices.find(x=>x.device_id===status.connectionChoice.deviceId);peerDeviceId=randomUUID();const request={version:2,operationId:randomUUID(),subjectId,kind:'authorize-device',expectedEpoch:state.epoch,previousEventHash:state.chainHead,signerKeyId:own.key_id,newDevice:{deviceId:peerDeviceId,publicKeyPem:peer.publicKeyPem,scopes:['binding']}},challenge=await native.api.call('/v2/identity/control/challenges',request,{authenticated:false});await native.api.call('/v2/identity/control/commit',{operationId:request.operationId,controllerSignature:await signIdentityPayload(challenge.challenge,material.privateKey),newDeviceProof:await signIdentityPayload(challenge.challenge,peer.privateKey)},{authenticated:false});}
const history=createLocalWorkHistory({dataDirectory:dir,getIdentity:native.localIdentityWithin}),note=await history.recordNote({galaxyId:subjectId,host:'opencode',sessionId:'opaque-session',text:'Synthetic isolated work statement'}),workId=note.workId;
const sync=createNativeWorkSync({dataDirectory:dir,endpoint,getIdentity:native.localIdentityWithin,call:native.api.call});await sync.choose({choiceId:randomUUID(),enabled:true,targetAccountId:targetId,workIds:[workId],includeExisting:true});const record=await history.exportWork({galaxyId:subjectId,workId}),dataJson=JSON.stringify(projectWorkHistoryForUpload({level:'history-overview'},record).data),selected=await sync.settings(),operationId=randomUUID(),unknownId=randomUUID();
const db=new DatabaseSync(dir+'/work-history/sync.sqlite'),scope=db.prepare('SELECT * FROM work_sync_scopes WHERE owner_id=? AND endpoint=? AND work_id=?').get(subjectId,endpoint,workId),stamp=new Date().toISOString(),insert=db.prepare('INSERT INTO work_sync_jobs(id,owner_id,endpoint,target_id,work_id,choice_id,scope_id,source_token,data_json,state,updated_at,expected_revision,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');insert.run(operationId,subjectId,endpoint,targetId,workId,selected.choice.choiceId,scope.scope_id,'original-source-token',dataJson,'prepared',stamp,null,null);db.close();const settings=await sync.settings();await sync.close();await native.close();
await writeFile(dir+'/work-upload-fixture.json',JSON.stringify({configuration:{version:2,endpoint,website:f.website,dataDirectory:dir,trustedKeys:Object.fromEntries(f.owner.bindings.trustedKeys)},origin,now:f.clock.now,operationId,unknownId,workId,targetId,dataJson,settings,peerDeviceId}));process.stdout.write('ready\n');process.stdin.resume();process.stdin.on('end',async()=>{await f.close();if(database)await database.end();});
let authBuffer='',authTail=Promise.resolve();process.stdin.setEncoding('utf8');process.stdin.on('data',part=>{authBuffer+=part;let at;while((at=authBuffer.indexOf('\n'))>=0){const line=authBuffer.slice(0,at);authBuffer=authBuffer.slice(at+1);authTail=authTail.then(async()=>{try{const input=JSON.parse(line),target=new URL(input.authorizationUrl);if(target.origin!==new URL(f.issuer.issuer).origin)throw Error('isolated OIDC issuer only');f.issuer.setAccount('isolated-native-account-link');const callback=await f.issuer.authorize(target.href);if(callback.pathname!=='/v1/identity/callback/forum-fixture')throw Error('isolated callback only');process.stdout.write('authorization '+JSON.stringify({callback:callback.pathname+callback.search})+'\n');}catch{process.stdout.write('authorization-error\n');}});}});
`
	flavor := ""
	if len(identityPeer) > 0 && identityPeer[0] {
		flavor = "identity-peer"
	}
	cmd := exec.Command("node", "--input-type=module", "-e", script, dir, dsn, flavor)
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
	reader := bufio.NewReader(stdout)
	for {
		line, readError := reader.ReadString('\n')
		if readError != nil {
			t.Fatalf("original work fixture: %v %s", readError, stderr.String())
		}
		if line == "ready\n" {
			break
		}
	}
	raw, e := os.ReadFile(filepath.Join(dir, "work-upload-fixture.json"))
	if e != nil {
		t.Fatal(e)
	}
	var metadata workUploadFixtureMetadata
	if e = json.Unmarshal(raw, &metadata); e != nil {
		t.Fatal(e)
	}
	store, e := NewStore(dir, metadata.Configuration.Endpoint)
	if e != nil {
		t.Fatal(e)
	}
	origin, _ := url.Parse(metadata.Origin)
	metadata.Authorize = func(authorizationURL string) string {
		t.Helper()
		raw, _ := json.Marshal(map[string]any{"authorizationUrl": authorizationURL})
		if _, e := stdin.Write(append(raw, '\n')); e != nil {
			t.Fatal(e)
		}
		for {
			line, e := reader.ReadString('\n')
			if e != nil {
				t.Fatal("isolated OIDC authorization unavailable")
			}
			if line == "authorization-error\n" {
				t.Fatal("isolated OIDC authorization rejected")
			}
			if strings.HasPrefix(line, "authorization ") {
				var result struct {
					Callback string `json:"callback"`
				}
				if json.Unmarshal([]byte(strings.TrimPrefix(line, "authorization ")), &result) != nil {
					t.Fatal("invalid isolated OIDC callback")
				}
				return result.Callback
			}
		}
	}
	return store, metadata, &connectionTestTransport{origin: origin}
}

func TestWorkUploadOriginalPreparedLostACKReconcilesWithoutResend(t *testing.T) {
	store, meta, transport := workUploadServiceFixture(t)
	ctx := context.Background()
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	upload := NewWorkUpload(rt)
	settings, e := upload.Settings(ctx)
	if e != nil {
		t.Fatal(e)
	}
	same(t, meta.Settings, settings)
	drop := true
	puts := 0
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/account-work/put" {
			puts++
			if drop {
				drop = false
				response.Body.Close()
				return nil, io.ErrUnexpectedEOF
			}
		}
		return response, nil
	})
	result, e := upload.Resume(ctx, meta.OperationID)
	if e != nil {
		t.Fatal(e)
	}
	if result.(map[string]any)["state"] != "unknown" || puts != 1 {
		t.Fatalf("lost ACK not retained: %v", result)
	}
	result, e = upload.Resume(ctx, meta.OperationID)
	if e != nil {
		t.Fatal(e)
	}
	if result.(map[string]any)["state"] != "stored" || puts != 1 {
		t.Fatalf("original receipt replayed PUT: %v", result)
	}
	stored, e := rt.Call(ctx, "/v2/account-work/get", map[string]any{"workId": meta.WorkID}, ConnectionCallOptions{AccountID: meta.TargetID})
	if e != nil {
		t.Fatal(e)
	}
	var expectedData any
	json.Unmarshal([]byte(meta.DataJSON), &expectedData)
	same(t, expectedData, stored["data"])
	if stored["lastOperationId"] != meta.OperationID || stored["audience"] != "owner-only" || stored["completeConversation"] != false {
		t.Fatal("work upload changed origin or coverage")
	}
	before := puts
	currentScope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = upload.queue(ctx, true, currentScope.Owner, &currentScope, func(db *sql.DB, owner string) error {
		_, e := db.ExecContext(ctx, "INSERT INTO work_sync_jobs(id,owner_id,endpoint,target_id,work_id,choice_id,scope_id,source_token,data_json,state,updated_at,expected_revision,revision) SELECT ?,owner_id,endpoint,target_id,work_id,choice_id,scope_id,'older-unknown-token',data_json,'unknown',updated_at,0,1 FROM work_sync_jobs WHERE id=?", meta.UnknownID, meta.OperationID)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	unresolved, e := upload.Resume(ctx, meta.UnknownID)
	if e != nil {
		t.Fatal(e)
	}
	if unresolved.(map[string]any)["state"] != "unknown" || unresolved.(map[string]any)["reconciliationRequired"] != true || puts != before {
		t.Fatal("older unknown operation was automatically POSTed")
	}
	currentScope, e = store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = upload.ChooseReviewed(ctx, WorkUploadChoice{ChoiceID: uuid.NewString(), Enabled: true, TargetAccountID: meta.TargetID, WorkIDs: []string{meta.WorkID}, IncludeExisting: true, RestoreWorkIDs: []string{meta.WorkID}}, &currentScope); e != nil {
		t.Fatal(e)
	}
	prepared, e := upload.Prepare(ctx, meta.WorkID)
	if e != nil {
		t.Fatal(e)
	}
	nextOperation := prepared.(map[string]any)["operationId"].(string)
	if nextOperation == meta.OperationID || nextOperation == meta.UnknownID {
		t.Fatal("new explicit source choice reused an unknown operation")
	}
	fresh, e := upload.Resume(ctx, nextOperation)
	if e != nil || fresh.(map[string]any)["state"] != "stored" {
		t.Fatalf("Go projection/queue/put path: %v %v", e, fresh)
	}
	if puts != before+1 {
		t.Fatal("Go prepared source sent more than once")
	}
	head, e := rt.Call(ctx, "/v2/account-work/get", map[string]any{"workId": meta.WorkID}, ConnectionCallOptions{AccountID: meta.TargetID})
	if e != nil {
		t.Fatal(e)
	}
	same(t, expectedData, head["data"])
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	stale := scope
	stale.Owner = "another-owner"
	start := transport.count()
	if _, e = rt.Call(ctx, "/v2/account-work/put", map[string]any{}, ConnectionCallOptions{AccountID: meta.TargetID, ExpectedScope: &stale}); fault.Code(e) != "native_connection_selection_changed" || transport.count() != start {
		t.Fatalf("pinned upload adopted a different owner: %v", e)
	}
}
func TestWorkUploadConfirmedReceiptCannotBeDowngraded(t *testing.T) {
	ctx := context.Background()
	store := materialStore(t)
	rt, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	upload := NewWorkUpload(rt)
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	var job map[string]any
	if e = upload.access(ctx, true, true, scope.Owner, &scope, func(db *sql.DB, owner string) error {
		if _, e := db.ExecContext(ctx, "INSERT INTO work_sync_jobs(id,owner_id,endpoint,target_id,work_id,choice_id,scope_id,source_token,data_json,state,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,'stored',?,1)", id, owner, store.Endpoint, uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), "original-token", "{}", localNow()); e != nil {
			return e
		}
		var e error
		job, e = oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE id=?", id)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	view, e := upload.mark(ctx, job, &scope, "unknown", "late_transport_failure")
	if e != nil || view["state"] != "stored" || view["error"] != nil {
		t.Fatalf("late error downgraded confirmed receipt: %v %v", e, view)
	}
}
