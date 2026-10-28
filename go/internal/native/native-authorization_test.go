package native

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeAuthorizationExactSavedBytesGoConsentAndOriginalJSRecovery(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := workUploadServiceFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	service := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	original, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(original)
	consents := deviceauth.Handler{Service: service, Next: fallback}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/consents" || r.URL.Path == "/v2/consents/receipt" {
			consents.ServeHTTP(w, r)
		} else {
			fallback.ServeHTTP(w, r)
		}
	}))
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	var posts atomic.Int32
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v1/consents" {
			posts.Add(1)
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	requestID := uuid.NewString()
	input := map[string]any{"requestId": requestID, "action": "profile.publish", "objectId": "unicode\u2028literal\\u2028", "payloadJson": "{ \"z\": 1, \"a\": \"原始字节\" }"}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = runtime.AuthorizeReviewed(ctx, input, &scope); e == nil {
		t.Fatal("lost ACK returned success")
	}
	if posts.Load() != 1 {
		t.Fatal("unknown automatically resent", posts.Load())
	}
	transport.setHook(nil)
	key := "native-authorization:" + store.Endpoint + ":" + requestID
	var saved map[string]any
	if e = store.With(ctx, false, func(dir string) error { _, e := readJSON(connectionRecordPath(dir, key), &saved); return e }); e != nil || saved["state"] != "result-unknown" {
		t.Fatal(saved, e)
	}
	prepared := uploadObject(saved["prepared"])
	signature := text(prepared["signedIntent"])
	signedRaw, e := base64.RawURLEncoding.DecodeString(strings.Split(signature, ".")[1])
	if e != nil {
		t.Fatal(e)
	}
	fixture := filepath.Join(t.TempDir(), "authorization.json")
	if e = writeJSON(fixture, map[string]any{"configuration": meta.Configuration, "origin": server.URL, "input": input, "prepared": prepared, "now": meta.Now, "signedPayload": string(signedRaw)}); e != nil {
		t.Fatal(e)
	}
	expected := initializationNode(t, `import {readFile} from 'node:fs/promises';import {createNativeRuntime} from './packages/galaxy-edge-mcp/src/native-v2/runtime.mjs';const f=JSON.parse(await readFile(process.argv[1],'utf8')),c=f.configuration;const value=f.input,input={requestId:value.requestId,action:value.action,objectId:value.objectId,payloadJson:value.payloadJson,visibility:'Private',viewers:[]};const intent=f.prepared.intent;const originalIntent={version:1,id:intent.id,subjectId:intent.subjectId,bindingId:intent.bindingId,endpoint:intent.endpoint,objectId:input.objectId,action:input.action,purpose:'operational',recipient:intent.endpoint,fields:Object.keys(JSON.parse(input.payloadJson)),visibility:'Private',viewers:[],payloadHash:intent.payloadHash,policyVersion:'0.1',issuedAt:f.now,expiresAt:f.now+2591900};if(JSON.stringify(originalIntent)!==f.signedPayload)throw Error('Exact original JSON.stringify bytes changed');let writes=0;const runtime=await createNativeRuntime({...c,trustedKeys:new Map(Object.entries(c.trustedKeys)),now:()=>f.now,autoResumePrivateSync:false,fetch:async(url,options)=>{const path=new URL(url).pathname;if(path==='/v1/consents')writes++;return fetch(f.origin+path+(new URL(url).search),options)}});try{const result=await runtime.authorize(input,{confirmed:true});console.log(JSON.stringify({result,writes,exists:await runtime.authorizationExists(input)}));}finally{await runtime.close()}`, fixture)
	if expected["writes"] != json.Number("0") || expected["exists"] != true || uploadObject(expected["result"])["consentId"] != requestID {
		t.Fatal("original JS did not recover exact saved consent", expected)
	}
	result, e := runtime.AuthorizeReviewed(ctx, input, nil)
	if e != nil || result["consentId"] != requestID || result["payloadJson"] != input["payloadJson"] {
		t.Fatal(result, e)
	}
	if e = store.With(ctx, false, func(dir string) error { _, e := readJSON(connectionRecordPath(dir, key), &saved); return e }); e != nil || text(uploadObject(saved["prepared"])["signedIntent"]) != signature {
		t.Fatal("recovery resigned original", e)
	}
	var count int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM consents WHERE id=$1", requestID).Scan(&count); e != nil || count != 1 {
		t.Fatal(count, e)
	}
	changed := identityClone(input)
	changed["payloadJson"] = "{\"z\":2}"
	if _, e = runtime.AuthorizeReviewed(ctx, changed, &scope); e == nil {
		t.Fatal("request ID reused for changed bytes")
	}
	for _, payload := range []string{`{"privateKey":"synthetic-only"}`, `{"rawContext":"synthetic-only"}`} {
		denied := identityClone(input)
		denied["requestId"] = uuid.NewString()
		denied["payloadJson"] = payload
		if _, e = runtime.AuthorizeReviewed(ctx, denied, &scope); e == nil {
			t.Fatal("forbidden consent field signed")
		}
	}
	serverMCP := mcp.NewServer(&mcp.Implementation{Name: "authorize", Version: "1"}, nil)
	registerNativeAuthorizationTool(serverMCP, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, runtime)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := serverMCP.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "authorize", Version: "1"}, nil)
	session, e := client.Connect(ctx, ct, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	materialCall(t, session, "galaxy_native_authorize", map[string]any{"requestId": requestID, "action": "profile.publish", "objectId": "same", "payloadJson": "{}", "confirmed": true}, true)
	recovered := materialCall(t, session, "galaxy_native_authorize", input, false)
	if recovered["consentId"] != requestID {
		t.Fatal(recovered)
	}
}
