package accounts

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
)

func TestPublicAccountOriginalRelationsPagingAndDomainConsumers(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	original := nodeAccounts(t, dsn, `
 await migrate(db,{roles:['api']});const {randomUUID}=await import('node:crypto');const {AccountPublicQuery}=await import('./packages/galaxy-official/src/accounts/public-query.mjs');const {CommunityForumV1}=await import('./packages/galaxy-official/src/community/community-forum-v1.mjs');const {PublicWriteService}=await import('./packages/galaxy-official/src/publishing/public-writes.mjs');const {bindForumIds}=await import('./packages/galaxy-official/src/shared/community-forum-ids-v1.mjs');
 const accounts=[];for(const [index,name]of ['public-one','public-two','private'].entries()){const a=await transaction(db,async tx=>{const a=await upsertOfficialAccountWithin(tx,{endpoint,issuer,externalSubject:name,verificationMethod:'email',verifiedAt:now()});await ensureOfficialAccountProfileWithin(tx,a.id,{subjectType:'person',now:now()});return a});accounts.push(a);await data.updateSettings({kind:'official-account',endpoint,accountId:a.id},{expectedRevision:0,displayName:name,archiveRetentionDays:null,publicQuery:{enabled:index!==2,scope:'profile-and-public-posts',showLinkedIds:true,showExternalCredentials:index===0}});}
 const subjects=[1,2,3].map(n=>'GUID10'+'0'.repeat(25)+n),bindings=[];for(const id of subjects){await db.query("INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,'controlled-relation-fixture','{}')",[id]);const challenge=randomUUID(),binding=randomUUID();bindings.push(binding);await db.query("INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at) VALUES($1::uuid,$2,'{}',$1::text,$3)",[challenge,id,new Date((now()+3600)*1000)]);await db.query("INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at) VALUES($1,$2,$3,$4,$5,'[]','controlled-no-real-credential',$6)",[binding,id,challenge,'a'.repeat(64),endpoint,new Date((now()+3600)*1000)]);}
 async function link(accountIndex,subjectIndex,{client='configured',sourceIssuer=issuer,externalSubject=['public-one','public-two','private'][accountIndex],sourceEndpoint=endpoint,revoked=false}={}){const id=randomUUID();await db.query("INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature,created_at,revoked_at) VALUES($1,$2,$3,$4,'controlled-provider',$5,$6,$7,'controlled-relation-not-authentication',$8,'controlled-signature',$9,$10)",[id,subjects[subjectIndex],bindings[subjectIndex],sourceEndpoint,sourceIssuer,externalSubject,client,'b'.repeat(64),new Date(now()*1000),revoked?new Date(now()*1000):null]);await db.query('INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4)',[id,accounts[accountIndex].id,subjects[subjectIndex],new Date(now()*1000)]);return id;}
 const validFirst=await link(0,0),validSecond=await link(0,1);await link(1,0);await link(2,0);await link(0,2,{client:'unconfigured'});await link(0,2,{sourceIssuer:'https://other-source.example.invalid'});await link(0,2,{externalSubject:'different-account'});await link(0,2,{sourceEndpoint:'https://other-endpoint.example.invalid'});await link(0,2,{revoked:true});
 const registry={providers:new Set([JSON.stringify([issuer,'configured'])]),runAuthorized:(actor,_scope,fn)=>transaction(db,tx=>fn(tx,{kind:'official-account',accountId:actor.accountId},actor)),resolveWithin:async(tx,actor)=>(await tx.query('SELECT * FROM community_accounts WHERE id=$1 AND endpoint=$2',[actor.accountId,endpoint])).rows[0]},access={db,endpoint,now};const forum=new CommunityForumV1(access,null,{accounts:registry,publicWrites:new PublicWriteService(access,registry)});let ordinal=0;for(const audience of [null,null,{read:{kind:'selected-accounts',accountIds:[accounts[1].id]},participate:{kind:'accounts'}}]){const payload=await bindForumIds('create-post','account:'+accounts[0].id,{schemaVersion:1,operationId:randomUUID(),accountId:accounts[0].id,postId:randomUUID(),versionId:randomUUID(),expectedHeadVersion:0,title:'controlled public query '+ordinal++,body:'隔离检查正文，不是用户资料填充。',links:[],topic:'technology',publishedUntil:now()+3600,...(audience?{audience}:{})});await forum.publish({kind:'official-account',accountId:accounts[0].id,endpoint},{payloadJson:JSON.stringify(payload)});}
 const query=new AccountPublicQuery({data,accounts:registry,forum});console.log(JSON.stringify({accounts,subjects,validFirst,validSecond,ids:await query.linkedIds(accounts[0].id,{limit:1}),reverse:await query.accountsForId(subjects[0],{limit:1}),posts:await query.posts(accounts[0].id,{limit:1})}));`)
	accounts := original["accounts"].([]any)
	first := accounts[0].(map[string]any)["id"].(string)
	second := accounts[1].(map[string]any)["id"].(string)
	hidden := accounts[2].(map[string]any)["id"].(string)
	subjects := original["subjects"].([]any)
	subject := subjects[0].(string)
	api := apiPool(t, dsn)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	service := &Service{Endpoint: "https://accounts.example.invalid", Now: now}
	forum := &community.Service{Pool: api, Endpoint: service.Endpoint, Now: now}
	providers := []Provider{{Issuer: "https://login.example.invalid", ClientID: "configured"}}
	authority := &httpAccountFixture{id: first}
	handler := Handler{Service: service, Pool: api, Identity: HTTPIdentityFunc(authority.Identity), CurrentProviders: func() []Provider { return providers }, PublicPostsPage: func(ctx context.Context, tx pgx.Tx, id string, raw []byte) (Object, error) {
		return forum.PublicForAccountWithin(ctx, tx, id, raw)
	}}
	call := func(path string) (int, Object) {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var out Object
		if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
			t.Fatalf("HTTP %d %s", w.Code, w.Body)
		}
		return w.Code, out
	}
	prefix := "/v1/account/public/"
	status, ids := call(prefix + first + "/ids?limit=1")
	if status != 200 || !reflect.DeepEqual(ids, original["ids"]) {
		t.Fatalf("original linked-ID page differs %d %s / %s", status, encode(t, ids), encode(t, original["ids"]))
	}
	status, reverse := call(prefix + "by-id/" + subject + "?limit=1")
	if status != 200 || !reflect.DeepEqual(reverse, original["reverse"]) {
		t.Fatalf("original reverse page differs %d %s", status, encode(t, reverse))
	}
	status, next := call(prefix + first + "/ids?limit=1&after=" + ids["nextAfter"].(string))
	if status != 200 || len(next["items"].([]any)) != 1 || next["nextAfter"] != nil {
		t.Fatalf("ID cursor continuation %d %s", status, encode(t, next))
	}
	status, next = call(prefix + "by-id/" + subject + "?limit=1&after=" + reverse["nextAfter"].(string))
	if status != 200 || len(next["items"].([]any)) != 1 || next["nextAfter"] != nil {
		t.Fatalf("account cursor continuation %d %s", status, encode(t, next))
	}
	for _, path := range []string{prefix + first + "/ids?limit=1&limit=2", prefix + first + "/ids?limit=51", prefix + first + "/ids?after=", prefix + "by-id/" + subject + "?after=not-a-uuid", prefix + first + "/posts?after=not-a-post-cursor"} {
		if status, out := call(path); status != 400 || out["error"] != "invalid_account_query" {
			t.Fatalf("invalid page contract %d %s", status, encode(t, out))
		}
	}
	if status, out := call(prefix + first + "/ids?limit=0x1"); status != 200 || len(out["items"].([]any)) != 1 {
		t.Fatalf("original JS numeric conversion %d %s", status, encode(t, out))
	}
	if status, _ := call(prefix + hidden + "/ids"); status != 404 {
		t.Fatal("private account linked IDs exposed")
	}
	providers = nil
	for _, path := range []string{prefix + first + "/ids", prefix + "by-id/" + subject} {
		if status, out := call(path); status != 200 || len(out["items"].([]any)) != 0 {
			t.Fatalf("removed provider retained associations %d %s", status, encode(t, out))
		}
	}
	providers = []Provider{{Issuer: "https://login.example.invalid", ClientID: "configured"}}
	if _, e := pool.Exec(ctx, "UPDATE external_identity_links SET revoked_at=now() WHERE id=$1", original["validFirst"]); e != nil {
		t.Fatal(e)
	}
	status, remaining := call(prefix + first + "/ids")
	if status != 200 || len(remaining["items"].([]any)) != 1 || remaining["items"].([]any)[0].(map[string]any)["subjectId"] != subjects[1] {
		t.Fatalf("revoked link remained %d %s", status, encode(t, remaining))
	}
	status, remaining = call(prefix + "by-id/" + subject)
	if status != 200 || len(remaining["items"].([]any)) != 1 || remaining["items"].([]any)[0].(map[string]any)["accountId"] != second {
		t.Fatalf("reverse revoked association remained %d %s", status, encode(t, remaining))
	}
	if _, e := pool.Exec(ctx, "UPDATE community_account_links SET subject_id=$2 WHERE identity_link_id=$1", original["validSecond"], subjects[2]); e != nil {
		t.Fatal(e)
	}
	if status, out := call(prefix + first + "/ids"); status != 200 || len(out["items"].([]any)) != 0 {
		t.Fatalf("mismatched bidirectional source joined %d %s", status, encode(t, out))
	}
	// Missing credential verification remains unavailable rather than projecting
	// imported SQL metadata as a valid credential. Consumer transport is explicit.
	if status, out := call(prefix + first + "/credentials"); status != 503 || out["error"] != "external_credentials_unavailable" {
		t.Fatalf("missing credential consumer %d %s", status, encode(t, out))
	}
	if status, _ := call(prefix + second + "/credentials"); status != 404 {
		t.Fatal("credential visibility flag bypassed")
	}
	credentialCalls := 0
	handler.PublicCredentialsPage = func(_ context.Context, _ pgx.Tx, id string, raw []byte) (Object, error) {
		credentialCalls++
		var page publicPage
		if e := json.Unmarshal(raw, &page); e != nil {
			t.Fatal(e)
		}
		if id != first || page.Limit != 1 {
			t.Fatalf("credential consumer page %s %s", id, raw)
		}
		return Object{"accountId": id, "items": []Object{}, "nextAfter": nil, "checkedAt": now().Unix()}, nil
	}
	if status, _ := call(prefix + first + "/credentials?limit=1"); status != 200 || credentialCalls != 1 {
		t.Fatal("qualified credential consumer not called")
	}
	if _, e := pool.Exec(ctx, "UPDATE official_account_profiles_v1 SET query_external_credentials=false WHERE account_id=$1", first); e != nil {
		t.Fatal(e)
	}
	if status, _ := call(prefix + first + "/credentials?limit=1"); status != 404 || credentialCalls != 1 {
		t.Fatal("disabled credentials reached consumer")
	}
	status, posts := call(prefix + first + "/posts?limit=1")
	if status != 200 {
		t.Fatalf("real community consumer %d %s", status, encode(t, posts))
	}
	if status, profile := call(prefix + first); status != 200 || profile["posts"] == nil || len(profile["posts"].(map[string]any)["items"].([]any)) != 2 {
		t.Fatalf("public profile omitted current forum projection %d %s", status, encode(t, profile))
	}
	expectedPosts := original["posts"].(map[string]any)
	for _, key := range []string{"items", "order", "scanTruncated", "checkedAt"} {
		if !reflect.DeepEqual(posts[key], expectedPosts[key]) {
			t.Fatalf("original public posts %s differs Go=%s JS=%s", key, encode(t, posts[key]), encode(t, expectedPosts[key]))
		}
	}
	decodeCursor := func(raw any) any {
		t.Helper()
		if raw == nil {
			return nil
		}
		encoded := strings.TrimPrefix(raw.(string), "fp1.")
		b, e := base64.RawURLEncoding.DecodeString(encoded)
		if e != nil {
			t.Fatal(e)
		}
		var out any
		if e = json.Unmarshal(b, &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	if !reflect.DeepEqual(decodeCursor(posts["nextAfter"]), decodeCursor(expectedPosts["nextAfter"])) {
		t.Fatal("post cursor source scope differs")
	}
	if status, _ := call(prefix + first + "/posts?limit=1&after=" + expectedPosts["nextAfter"].(string)); status != 200 {
		t.Fatal("Go rejected original JS post cursor")
	}
	if status, out := call(prefix + second + "/posts?limit=1&after=" + posts["nextAfter"].(string)); status != 400 || out["error"] != "forum_cursor_mismatch" {
		t.Fatalf("cross-account cursor accepted %d %s", status, encode(t, out))
	}
	handler.PublicPostsPage = nil
	if status, out := call(prefix + first + "/posts"); status != 503 || out["error"] != "forum_unavailable" {
		t.Fatalf("missing posts consumer %d %s", status, encode(t, out))
	}
	if _, e := pool.Exec(ctx, "UPDATE official_account_profiles_v1 SET query_scope='profile' WHERE account_id=$1", first); e != nil {
		t.Fatal(e)
	}
	if status, _ := call(prefix + first + "/posts"); status != 404 {
		t.Fatal("profile-only scope exposed posts")
	}
}
