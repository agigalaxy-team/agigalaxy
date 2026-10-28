package failureaudit

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func node(t *testing.T, script string, env []string, args ...string) []byte {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", append([]string{"--no-warnings", "--input-type=module", "-e", script}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), env...)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original JS check: %v %s", e, out)
	}
	return out
}
func TestOriginalRouteTemplatesAndUnknownPrivacy(t *testing.T) {
	paths := []string{"/private-path-secret?code=PRIVATE", "/v1/identity/callback/google", "/v1/identity/callback/:provider", "/v1/operations/rules/community-quota/publish", "/v1/operations/rules/:key/sample", "/mcp/personal", "/.well-known/oauth-protected-resource/mcp/personal", "/v1/account/public/by-uid/AbC123", "/v1/operations/agentos/runs/run_A-2"}
	id := "11111111-1111-4111-8111-111111111111"
	for _, p := range []string{"/v1/operations/files/chat/ID/access", "/v1/operations/files/access/operations/ID", "/v1/operations/rules/operations/ID", "/v1/operations/agentos/executions/ID/continue", "/v1/account/public/ID/posts", "/v1/operations/users/ID/restriction/release", "/v1/operations/jobs/messaging-delivery/ID/retry", "/v1/operations/messaging/plans/ID/history", "/v1/operations/messaging/runs/ID/recipients", "/v1/announcements/ID", "/v1/operations/search/failures/ID/retry", "/v1/operations/chat-reports/ID/attachments/ID/content", "/v1/operations/content/publications/ID", "/v2/community/reports/ID/receipt", "/v2/chat/attachments/ID/export-content", "/v1/proofs/ID/revoke", "/v1/bindings/ID/status"} {
		paths = append(paths, strings.ReplaceAll(p, "ID", id))
	}
	for p := range fixedRoutes {
		paths = append(paths, p)
	}
	raw, _ := json.Marshal(paths)
	script := `import {failureRoute} from './packages/galaxy-official/src/adapters/http/failure-audit.mjs';const rows=[];for(const method of ['GET','POST','DELETE','PATCH'])for(const path of JSON.parse(process.argv[1]))rows.push({method,path,route:failureRoute(method,path)});console.log(JSON.stringify(rows));`
	var rows []struct{ Method, Path, Route string }
	if e := json.Unmarshal(node(t, script, nil, string(raw)), &rows); e != nil {
		t.Fatal(e)
	}
	for _, v := range rows {
		if got := FailureRoute(v.Method, v.Path); got != v.Route {
			t.Fatalf("%s %s: %s != %s", v.Method, v.Path, got, v.Route)
		}
	}
}
func TestOriginalSQLiteUpgradePostgresRecoveryUnknownACKAndDeletion(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "audit.sqlite")
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {DatabaseSync} from 'node:sqlite';import {writeFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {serviceFixture} from './packages/galaxy-official/test/service-fixture.mjs';import {createFailureAuditSpool} from './packages/galaxy-official/src/infrastructure/failure-audit-spool.mjs';const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated DB required');const db=new pg.Pool({connectionString:url.href});try{const f=await serviceFixture(['binding','consent','case-teaser'],db);const authenticated=await f.access.authenticate(f.credential,'case-teaser');const actor={subjectId:authenticated.subjectId,bindingId:authenticated.bindingId,authentication:authenticated.authentication};const legacy={requestId:randomUUID(),status:503,route:'POST /v1/cases',actor:{subjectId:actor.subjectId,bindingId:actor.bindingId},observedAt:new Date(f.now*1000).toISOString()};await writeFile(process.argv[1],'',{mode:0o600});const queue=new DatabaseSync(process.argv[1]);queue.exec('CREATE TABLE metadata(endpoint TEXT PRIMARY KEY);CREATE TABLE pending(request_id TEXT PRIMARY KEY,event_json TEXT NOT NULL);PRAGMA user_version=1;');queue.prepare('INSERT INTO metadata VALUES (?)').run(f.bindings.endpoint);queue.prepare('INSERT INTO pending VALUES (?,?)').run(legacy.requestId,JSON.stringify(legacy));queue.close();const s=await createFailureAuditSpool({path:process.argv[1],endpoint:f.bindings.endpoint,intervalMs:60000,write:()=>{throw Error('PRIVATE-OUTAGE')}});const modern={...legacy,requestId:randomUUID(),status:401,actor};if(await s.record({...modern,body:'PRIVATE-BODY',headers:{authorization:'PRIVATE-TOKEN'}})!=='queued')throw Error('queue failed');await s.flush();await s.close();console.log(JSON.stringify({legacy,modern,endpoint:f.bindings.endpoint}));}finally{await db.end()}`
	var metadata struct {
		Legacy, Modern Event
		Endpoint       string
	}
	if e := json.Unmarshal(node(t, script, []string{"GALAXY_GO_TEST_DATABASE_URL=" + dsn}, path), &metadata); e != nil {
		t.Fatal(e)
	}
	// The original v1 SQLite file is upgraded without recreating its queue.
	s := mustSpool(t, SpoolOptions{Path: path, Endpoint: metadata.Endpoint, Interval: time.Minute, Write: func(context.Context, Event) (Result, error) { return Result{}, errors.New("PRIVATE-OUTAGE") }})
	flush(t, s)
	if pending(s) != 2 {
		t.Fatal("legacy queue lost")
	}
	s.Close()
	db, e := sql.Open("sqlite", path)
	if e != nil {
		t.Fatal(e)
	}
	var version int
	db.QueryRow("PRAGMA user_version").Scan(&version)
	var raw string
	db.QueryRow("SELECT event_json FROM pending WHERE request_id=?", metadata.Modern.RequestID).Scan(&raw)
	db.Close()
	if version != 2 || strings.Contains(raw, "PRIVATE-") {
		t.Fatal("upgrade leaked/lost context")
	}
	// Later delivery preserves the authentication-time snapshot despite changes.
	_, e = pool.Exec(ctx, `UPDATE bindings SET scopes='["binding"]',revoked_at=now() WHERE id=$1`, metadata.Modern.Actor.BindingID)
	if e != nil {
		t.Fatal(e)
	}
	_, e = pool.Exec(ctx, `UPDATE binding_challenges SET payload=jsonb_set(payload,'{installationId}',to_jsonb($2::text)) WHERE id=(SELECT challenge_id FROM bindings WHERE id=$1)`, metadata.Modern.Actor.BindingID, uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	write := PostgresWriter(pool, metadata.Endpoint, func() time.Time { return time.Unix(2000000000, 0) })
	var calls atomic.Int32
	s = mustSpool(t, SpoolOptions{Path: path, Endpoint: metadata.Endpoint, Interval: time.Minute, Write: func(c context.Context, e Event) (Result, error) {
		v, err := write(c, e)
		if calls.Add(1) == 1 && err == nil {
			return Result{}, errors.New("PRIVATE-LOST-ACK")
		}
		return v, err
	}})
	flush(t, s)
	if pending(s) != 2 {
		t.Fatal("unknown ACK discarded")
	}
	flush(t, s)
	if pending(s) != 0 {
		t.Fatal("recovery not delivered", s.Status())
	}
	s.Close()
	var n int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE http_request_id=ANY($1::uuid[])", []string{metadata.Legacy.RequestID, metadata.Modern.RequestID}).Scan(&n); e != nil || n != 2 {
		t.Fatal("dedup", n, e)
	}
	var scope *string
	var scopes []string
	var client string
	var contextVersion int
	if e = pool.QueryRow(ctx, "SELECT scope,credential_scopes,caller_client_id,context_version FROM audit_events WHERE http_request_id=$1", metadata.Modern.RequestID).Scan(&scope, &scopes, &client, &contextVersion); e != nil || scope == nil || *scope != metadata.Modern.Actor.Authentication.Scope || !reflect.DeepEqual(scopes, metadata.Modern.Actor.Authentication.CredentialScopes) || client != metadata.Modern.Actor.Authentication.ClientID || contextVersion != 0 {
		t.Fatal("snapshot changed", e)
	}
	if e = pool.QueryRow(ctx, "SELECT scope,credential_scopes FROM audit_events WHERE http_request_id=$1", metadata.Legacy.RequestID).Scan(&scope, &scopes); e != nil || scope != nil || scopes != nil {
		t.Fatal("legacy unknown fabricated", e)
	}
	// Compare the original writer against the same existing PG schema.
	comparison := metadata.Modern
	comparison.RequestID = uuid.NewString()
	input, _ := json.Marshal(comparison)
	original := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import {httpFailureWriter} from './packages/galaxy-official/src/infrastructure/http-failure-audit.mjs';const url=new URL(process.env.GALAXY_GO_TEST_DATABASE_URL);if(url.hostname!=='127.0.0.1'||!url.pathname.startsWith('/galaxy_go_test_'))throw Error('isolated DB required');const db=new pg.Pool({connectionString:url.href});try{await httpFailureWriter(db,process.argv[1],{now:()=>2000000000})(JSON.parse(process.argv[2]));console.log('{}')}finally{await db.end()}`
	node(t, original, []string{"GALAXY_GO_TEST_DATABASE_URL=" + dsn}, metadata.Endpoint, string(input))
	var equal bool
	e = pool.QueryRow(ctx, `SELECT (to_jsonb(a)-'sequence'-'request_id'-'http_request_id'-'idempotency_key')=(to_jsonb(b)-'sequence'-'request_id'-'http_request_id'-'idempotency_key') FROM audit_events a,audit_events b WHERE a.http_request_id=$1 AND b.http_request_id=$2`, metadata.Modern.RequestID, comparison.RequestID).Scan(&equal)
	if e != nil || !equal {
		t.Fatal("original PG writer projection differs", e)
	}
	_, e = pool.Exec(ctx, `INSERT INTO deletion_requests(id,subject_id,binding_id,requester_public_key,payload_text,payload_hash,signature,state,revision,execution_result) VALUES($1,$2,$3,'fixture','{}','fixture','fixture','primary-erased',1,'{"audit":{"until":1999999999}}')`, uuid.NewString(), metadata.Modern.Actor.SubjectID, metadata.Modern.Actor.BindingID)
	if e != nil {
		t.Fatal(e)
	}
	erased := metadata.Modern
	erased.RequestID = uuid.NewString()
	result, e := write(ctx, erased)
	if e != nil || result.State != "suppressed-by-deletion" {
		t.Fatal("erasure reinserted", e, result)
	}
	pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE http_request_id=$1", erased.RequestID).Scan(&n)
	if n != 0 {
		t.Fatal("deleted audit resurrected")
	}
	wrong := metadata.Modern
	auth := *wrong.Actor.Authentication
	auth.Audience = "https://other.invalid"
	actor := *wrong.Actor
	actor.Authentication = &auth
	wrong.Actor = &actor
	if _, e = write(ctx, wrong); e == nil {
		t.Fatal("wrong audience delivered")
	}
}
