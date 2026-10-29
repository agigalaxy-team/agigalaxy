package failureaudit

import (
	"context"
	"database/sql"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRouteTemplatesAndUnknownPrivacy(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	for _, row := range []struct{ method, path, route string }{
		{"GET", "/private-path-secret?code=PRIVATE", "http.request"},
		{"GET", "/v1/identity/callback/google", "GET /v1/identity/callback/:provider"},
		{"POST", "/v1/operations/rules/community-quota/publish", "POST /v1/operations/rules/:key/publish"},
		{"GET", "/v1/account/public/" + id + "/posts", "GET /v1/account/public/:id/posts"},
		{"GET", "/v1/operations/agentos/runs/run_A-2", "GET /v1/operations/agentos/runs/:run"},
		{"POST", "/v2/chat/attachments/" + id + "/export-content", "POST /v2/chat/attachments/:id/export-content"},
		{"DELETE", "/mcp/personal", "DELETE /mcp/personal"},
		{"PATCH", "/v1/cases", "http.request"},
		{"GET", "/.well-known/oauth-protected-resource/mcp/personal", "GET /.well-known/oauth-protected-resource/mcp/personal"},
	} {
		if got := FailureRoute(row.method, row.path); got != row.route {
			t.Fatalf("%s %s: %s != %s", row.method, row.path, got, row.route)
		}
	}
}
func TestLegacySQLiteUpgradePostgresRecoveryUnknownACKAndDeletion(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "audit.sqlite")
	if _, e := databaseschema.Migrate(ctx, pool, []string{"api"}); e != nil {
		t.Fatal(e)
	}
	endpoint := "https://audit.example.invalid"
	subject, binding, challenge, clientID := "GUID"+strings.Repeat("0", 28), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, e := pool.Exec(ctx, `INSERT INTO subjects(id,public_key,genesis_proof) VALUES($1,'synthetic-audit-subject','{}')`, subject); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO binding_challenges(id,subject_id,payload,token_hash,expires_at) VALUES($1,$2,jsonb_build_object('installationId',$3::text),'synthetic-audit-challenge',to_timestamp(2000003600))`, challenge, subject, clientID); e != nil {
		t.Fatal(e)
	}
	if _, e := pool.Exec(ctx, `INSERT INTO bindings(id,subject_id,challenge_id,request_hash,audience,scopes,receipt,expires_at) VALUES($1,$2,$3,'synthetic-audit-binding',$4,'["binding","consent","case-teaser"]','synthetic-audit-receipt',to_timestamp(2000003600))`, binding, subject, challenge, endpoint); e != nil {
		t.Fatal(e)
	}
	legacy := Event{RequestID: uuid.NewString(), Status: 503, Route: "POST /v1/cases", Actor: &Actor{SubjectID: subject, BindingID: binding}, ObservedAt: "2033-05-18T03:33:20.000Z"}
	modern := legacy
	modern.RequestID, modern.Status = uuid.NewString(), 401
	modern.Actor = &Actor{SubjectID: subject, BindingID: binding, Authentication: &Authentication{Version: 1, ClientID: clientID, Audience: endpoint, Scope: "case-teaser", BindingScopes: []string{"binding", "consent", "case-teaser"}, CredentialScopes: []string{"binding", "consent", "case-teaser"}}}
	metadata := struct {
		Legacy, Modern Event
		Endpoint       string
	}{legacy, modern, endpoint}
	// Build the documented v1 queue format directly. Current Go opens and upgrades it.
	if e := os.WriteFile(path, nil, 0600); e != nil {
		t.Fatal(e)
	}
	queue, e := sql.Open("sqlite", path)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = queue.Exec(`CREATE TABLE metadata(endpoint TEXT PRIMARY KEY);CREATE TABLE pending(request_id TEXT PRIMARY KEY,event_json TEXT NOT NULL);PRAGMA user_version=1;`); e != nil {
		t.Fatal(e)
	}
	if _, e = queue.Exec("INSERT INTO metadata VALUES (?)", endpoint); e != nil {
		t.Fatal(e)
	}
	if _, e = queue.Exec("INSERT INTO pending VALUES (?,?)", legacy.RequestID, encode(legacy)); e != nil {
		t.Fatal(e)
	}
	if e = queue.Close(); e != nil {
		t.Fatal(e)
	}
	// The original v1 SQLite file is upgraded without recreating its queue.
	s := mustSpool(t, SpoolOptions{Path: path, Endpoint: metadata.Endpoint, Interval: time.Minute, Write: func(context.Context, Event) (Result, error) { return Result{}, errors.New("PRIVATE-OUTAGE") }})
	flush(t, s)
	if pending(s) != 1 {
		t.Fatal("v1 queue lost", s.Status())
	}
	if s.Record(ctx, modern) != "queued" {
		t.Fatal("modern event not committed")
	}
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
	var action, objectID, outcome, audience, key string
	if e = pool.QueryRow(ctx, `SELECT action,object_id,outcome,audience,idempotency_key FROM audit_events WHERE http_request_id=$1`, modern.RequestID).Scan(&action, &objectID, &outcome, &audience, &key); e != nil || action != "http.rejected" || objectID != modern.Route || outcome != "401" || audience != endpoint || key != modern.RequestID {
		t.Fatal("stored bounded audit context", e, action, objectID, outcome, audience, key)
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
