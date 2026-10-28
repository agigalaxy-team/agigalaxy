package accountarchive

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func node(t *testing.T, dsn, mode, path string, stdin []byte) Object {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "go/internal/accountarchive/testdata/interop.mjs"), mode, path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader(stdin)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, e := cmd.Output()
	if e != nil {
		t.Fatalf("original account archive %s: %v %s", mode, e, stderr.String())
	}
	var result Object
	if json.Unmarshal(out, &result) != nil {
		t.Fatal("invalid original fixture output")
	}
	return result
}
func normal(v any) any { var out any; _ = json.Unmarshal(encoded(v), &out); return out }
func same(t *testing.T, a, b any) {
	t.Helper()
	if !reflect.DeepEqual(normal(a), normal(b)) {
		t.Fatalf("original projection differs\nGo=%s\nJS=%s", encoded(a), encoded(b))
	}
}
func expect(t *testing.T, e error, code string) {
	t.Helper()
	if fault.Code(e) != code {
		t.Fatalf("expected %s: %v", code, e)
	}
}
func TestOriginalJSGoPrivateCopiesAndLostACK(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "archive-fixture.json")
	node(t, dsn, "setup", path, nil)
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Endpoint, Issuer, AccountID, Token, Link string
		Put, Archive, JSReceipt                  Object
	}
	if json.Unmarshal(raw, &f) != nil {
		t.Fatal("invalid fixture")
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := time.Unix(2000000000, 0)
	device := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: func() time.Time { return now }}
	registry := &accountlinks.Service{Pool: pool, Endpoint: f.Endpoint, Devices: device, Providers: []accountlinks.Provider{{Issuer: f.Issuer, ClientID: "archive-fixture"}}}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Now: func() time.Time { return now }, Devices: device, Registry: registry}
	verified, e := device.Authenticate(ctx, f.Token, "binding")
	if e != nil {
		t.Fatal(e)
	}
	a := Actor{Device: verified, AccountID: f.AccountID}
	original := node(t, dsn, "read", path, nil)
	got, e := s.Work(ctx, a, "get", encoded(Object{"workId": f.Put["workId"]}))
	if e != nil {
		t.Fatal(e)
	}
	same(t, got, original["work"])
	got, e = s.Work(ctx, a, "list", []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	same(t, got, original["workList"])
	got, e = s.Archive(ctx, a, "status", encoded(Object{"id": f.Archive["id"]}))
	if e != nil {
		t.Fatal(e)
	}
	same(t, got, original["archive"])
	got, e = s.Archive(ctx, a, "list", []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	same(t, got, original["archives"])
	got, e = s.Work(ctx, a, "put", encoded(f.Put))
	if e != nil {
		t.Fatal(e)
	}
	receipt := normal(f.JSReceipt).(map[string]any)
	receipt["duplicate"] = true
	same(t, got, receipt)
	// A lost successful HTTP response is followed only by original-object status.
	server := httptest.NewServer(Handler{Service: s, Devices: device})
	defer server.Close()
	call := func(path string, input any) (int, Object) {
		t.Helper()
		request, _ := http.NewRequest("POST", server.URL+path, bytes.NewReader(encoded(input)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+f.Token)
		request.Header.Set("X-Galaxy-Account-ID", f.AccountID)
		response, e := http.DefaultClient.Do(request)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		var out Object
		_ = json.Unmarshal(body, &out)
		return response.StatusCode, out
	}
	code, _ := call("/v2/account-archives/chunk", Object{"id": f.Archive["id"], "sequence": 1, "content": "Go committed chunk; ACK discarded"})
	if code != 200 {
		t.Fatalf("chunk HTTP %d", code)
	}
	code, status := call("/v2/account-archives/status", Object{"id": f.Archive["id"]})
	if code != 200 {
		t.Fatal(code)
	}
	same(t, status["storedSequences"], []int{0, 1})
	if _, e = s.Archive(ctx, a, "complete", encoded(Object{"id": f.Archive["id"], "chunkCount": 2})); e != nil {
		t.Fatal(e)
	}
	got, e = s.Archive(ctx, a, "export", encoded(Object{"id": f.Archive["id"], "sequence": 1}))
	if e != nil || got["content"] != "Go committed chunk; ACK discarded" || got["nextSequence"] != nil {
		t.Fatalf("export %v", e)
	}
	// Original JavaScript reads the same committed rows, including ordered chunks.
	original = node(t, dsn, "read", path, nil)
	got, e = s.Archive(ctx, a, "status", encoded(Object{"id": f.Archive["id"]}))
	if e != nil {
		t.Fatal(e)
	}
	same(t, got, original["archive"])
	put := normal(f.Put).(map[string]any)
	put["operationId"] = uuid.NewString()
	put["revision"] = 2
	put["expectedRevision"] = 1
	code, _ = call("/v2/account-work/put", put)
	if code != 200 {
		t.Fatalf("work HTTP %d", code)
	}
	code, status = call("/v2/account-work/status", Object{"workId": put["workId"]})
	if code != 200 || status["lastOperationId"] != put["operationId"] || status["revision"] != float64(2) {
		t.Fatal("lost ACK did not reconcile original operation")
	}
	original = node(t, dsn, "read", path, nil)
	got, e = s.Work(ctx, a, "get", encoded(Object{"workId": put["workId"]}))
	if e != nil {
		t.Fatal(e)
	}
	same(t, got, original["work"])
	// Configured original growth enforcement rolls back scope, content and receipt.
	rollback := normal(put).(map[string]any)
	rollback["operationId"] = uuid.NewString()
	rollback["workId"] = "rolled-back"
	rollback["scopeId"] = uuid.NewString()
	rollback["revision"] = 1
	rollback["expectedRevision"] = 0
	rollback["data"].(map[string]any)["workId"] = "rolled-back"
	s.ResourceWrite = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, authorize func() error, operation func() (Object, error)) (Object, error) {
		if e := authorize(); e != nil {
			return nil, e
		}
		if _, e := operation(); e != nil {
			return nil, e
		}
		return nil, fault.New("resource_budget_exceeded", 429)
	}
	_, e = s.Work(ctx, a, "put", encoded(rollback))
	expect(t, e, "resource_budget_exceeded")
	s.ResourceWrite = nil
	var count int
	if e = owner.QueryRow(ctx, `SELECT (SELECT count(*) FROM account_work_v1 WHERE work_id='rolled-back')+(SELECT count(*) FROM account_work_operations_v1 WHERE operation_id=$1)+(SELECT count(*) FROM account_work_scopes_v1 WHERE scope_id=$2)`, rollback["operationId"], rollback["scopeId"]).Scan(&count); e != nil || count != 0 {
		t.Fatalf("transaction leaked %d %v", count, e)
	}
	if _, e = s.Work(ctx, a, "delete", encoded(Object{"workId": put["workId"]})); e != nil {
		t.Fatal(e)
	}
	_, e = s.Work(ctx, a, "put", encoded(put))
	expect(t, e, "account_work_owner_deleted")
	if _, e = s.Archive(ctx, a, "delete", encoded(Object{"id": f.Archive["id"]})); e != nil {
		t.Fatal(e)
	}
	_, e = s.Archive(ctx, a, "create", encoded(f.Archive))
	expect(t, e, "archive_deleted")
	reselect := normal(f.Archive).(map[string]any)
	reselect["id"] = uuid.NewString()
	_, e = s.Archive(ctx, a, "create", encoded(reselect))
	expect(t, e, "archive_deleted")
	reselect["selection"].(map[string]any)["scopeId"] = uuid.NewString()
	if _, e = s.Archive(ctx, a, "create", encoded(reselect)); e != nil {
		t.Fatal(e)
	}
	// Original retention expiry produces an expired tombstone and no prose.
	if _, e = owner.Exec(ctx, `UPDATE private_conversation_archives_v1 SET expires_at=$2 WHERE id=$1`, reselect["id"], now); e != nil {
		t.Fatal(e)
	}
	got, e = s.Archive(ctx, a, "status", encoded(Object{"id": reselect["id"]}))
	if e != nil || got["reason"] != "expired" {
		t.Fatalf("expiry %v %v", got, e)
	}
	// A cursor survives removal of its anchor; it is still bound to this owner
	// and origin and never authorizes a different linked identity's private copy.
	for i := 0; i < 3; i++ {
		create := normal(f.Archive).(map[string]any)
		create["id"] = uuid.NewString()
		create["selection"].(map[string]any)["scopeId"] = uuid.NewString()
		if _, e = s.Archive(ctx, a, "create", encoded(create)); e != nil {
			t.Fatal(e)
		}
	}
	page, e := s.Archive(ctx, a, "list", []byte(`{"limit":1}`))
	if e != nil {
		t.Fatal(e)
	}
	cursor, ok := page["nextAfter"].(string)
	if !ok {
		t.Fatal("missing original archive cursor")
	}
	anchor := page["archives"].([]Object)[0]["id"]
	if _, e = s.Archive(ctx, a, "delete", encoded(Object{"id": anchor})); e != nil {
		t.Fatal(e)
	}
	page, e = s.Archive(ctx, a, "list", encoded(Object{"after": cursor, "limit": 1}))
	if e != nil || len(page["archives"].([]Object)) != 1 {
		t.Fatalf("erased cursor anchor %v", e)
	}
	official := Actor{Official: true, Endpoint: f.Endpoint, AccountID: f.AccountID, AuthorizeAccount: func(context.Context, pgx.Tx, string, string) error { return nil }}
	_, e = s.Archive(ctx, official, "list", encoded(Object{"after": cursor}))
	expect(t, e, "invalid_archive_cursor")
	other := normal(f.Archive).(map[string]any)
	other["id"] = uuid.NewString()
	other["selection"].(map[string]any)["scopeId"] = uuid.NewString()
	if _, e = s.Archive(ctx, official, "create", encoded(other)); e != nil {
		t.Fatal(e)
	}
	got, e = s.Archive(ctx, a, "status", encoded(Object{"id": other["id"]}))
	if e != nil || got["state"] != "absent" {
		t.Fatal("linked identity read a different origin")
	}
	got, e = s.Accounts(ctx, a, []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	for _, view := range got["accounts"].([]Object) {
		if _, yes := view["issuer"]; yes {
			t.Fatal("accounts route leaked raw registry row")
		}
	}
	for _, path := range []string{"/v2/account-work/status?unexpected=1", "/v2/account-work/unknown", "/v1/account/work/put"} {
		code, _ := call(path, Object{})
		if code != 404 {
			t.Fatalf("original route acceptance %s %d", path, code)
		}
	}
	request, _ := http.NewRequest("POST", server.URL+"/v2/account-archives/status", bytes.NewReader(encoded(Object{"id": other["id"]})))
	request.Header.Set("Content-Type", "application/json")
	response, e := http.DefaultClient.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	_ = response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("anonymous private archive accepted")
	}
	// Provider removal and current binding revocation must win on existing Actor.
	registry.Providers = nil
	_, e = s.Work(ctx, a, "status", encoded(Object{"workId": put["workId"]}))
	expect(t, e, "account_target_unavailable")
	registry.Providers = []accountlinks.Provider{{Issuer: f.Issuer, ClientID: "archive-fixture"}}
	if _, e = owner.Exec(ctx, `UPDATE bindings SET revoked_at=$2 WHERE id=$1`, a.Device.BindingID, now); e != nil {
		t.Fatal(e)
	}
	_, e = s.Work(ctx, a, "status", encoded(Object{"workId": put["workId"]}))
	expect(t, e, "access_denied")
}

func TestWorkProjectionOriginalStrictSchema(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	path := filepath.Join(t.TempDir(), "archive-fixture.json")
	node(t, dsn, "setup", path, nil)
	raw, _ := os.ReadFile(path)
	var f struct{ Put Object }
	_ = json.Unmarshal(raw, &f)
	tests := []Object{f.Put}
	change := func(fn func(Object)) { o := normal(f.Put).(map[string]any); fn(o); tests = append(tests, o) }
	change(func(o Object) { o["extra"] = true })
	change(func(o Object) { o["data"].(map[string]any)["summary?"] = Object{"unexpected": true} })
	change(func(o Object) { delete(o, "data") })
	change(func(o Object) { o["revision"] = 2 })
	change(func(o Object) { o["scopeId"] = "11111111-1111-0111-0111-111111111111" })
	change(func(o Object) { o["data"].(map[string]any)["summary"] = Object{"title": "forbidden overview prose"} })
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["uploadLevel"] = "work-content"
		d["summary"] = Object{"title": "private title", "summary": "Synthetic work", "outcome": "unknown", "summaryRevision": 0, "sourceKind": "host-observations"}
	})
	observation := func() Object {
		return Object{"id": uuid.NewString(), "sequence": 5, "sourceId": "opaque-source", "revision": 1, "latestRevision": 1, "superseded": false, "kind": "message", "occurredAt": nil, "observedAt": "2033-05-18T03:33:20.000Z", "source": Object{"kind": "host-event"}, "content": Object{"excerpt": "Controlled retained excerpt", "retained": "excerpt", "availableFromHost": true}, "details": Object{"ordinaryNumber": -1.5}, "exclusions": []any{}, "environmentId": nil, "environmentMeaning": "observed-at-collection", "localOnly": true}
	}
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["uploadLevel"] = "work-content"
		d["observations"] = []any{observation()}
		d["coverage"] = Object{"observations": Object{"sourceTotal": 10, "included": 1, "firstSequence": 5, "lastSequence": 5, "hasEarlier": true}, "omittedFields": []any{"summary", "environments"}}
	})
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["uploadLevel"] = "work-content"
		obs := observation()
		delete(obs, "details")
		d["observations"] = []any{obs}
	})
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["uploadLevel"] = "work-content"
		obs := observation()
		obs["latestRevision"] = 2
		d["observations"] = []any{obs}
	})
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["uploadLevel"] = "work-content"
		obs := observation()
		d["observations"] = []any{obs, obs}
	})
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["source"].(map[string]any)["sessionId"] = "private/path"
	})
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["uploadLevel"] = "work-content"
		d["summary"] = Object{"title": "private title", "summary": "password=unsafe-not-accepted", "outcome": "unknown", "summaryRevision": 0, "sourceKind": "host-observations"}
	})
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["environments"] = []any{Object{"id": uuid.NewString(), "version": 1, "observedAt": "2033-05-18T03:33:20Z", "facts": Object{"selectedModel": "provider/model"}}}
	})
	change(func(o Object) {
		d := o["data"].(map[string]any)
		d["environments"] = []any{Object{"id": uuid.NewString(), "version": 1, "observedAt": "2033-05-18T03:33:20Z", "facts": Object{"selectedModel": "C:/private"}}}
	})
	original := node(t, dsn, "validate", path, encoded(tests))
	checks := original["checks"].([]any)
	for i, test := range tests {
		_, e := parseWork(encoded(test), "put")
		if (e == nil) != checks[i].(bool) {
			t.Fatalf("strict original schema divergence at %d: %v", i, e)
		}
	}
	// Decoder keeps safe integer sequences and rejects null required fields.
	var p Object
	if protocol.Decode(encoded(f.Put), &p) != nil {
		t.Fatal("fixture decode")
	}
	p["expectedRevision"] = nil
	if _, e := parseWork(encoded(p), "put"); e == nil {
		t.Fatal("null revision accepted")
	}
}
