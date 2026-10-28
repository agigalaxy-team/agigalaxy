package feedback

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Explicit fixture authority, not a production authentication implementation.
type fixtureAuthority struct{ revoked bool }

func (f *fixtureAuthority) Account(ctx context.Context, tx pgx.Tx, endpoint, id string) error {
	if f.revoked {
		return fault.New("official_account_login_required", 401)
	}
	var exists bool
	e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM community_accounts WHERE endpoint=$1 AND id=$2)", endpoint, id).Scan(&exists)
	if e != nil {
		return e
	}
	if !exists {
		return fault.New("official_account_login_required", 401)
	}
	return nil
}
func (f *fixtureAuthority) Operator(_ context.Context, _ pgx.Tx, _, id, permission string) (Operator, error) {
	if f.revoked || id != "go-admin" && id != "go-reader" || permission == "feedback.update" && id != "go-admin" {
		return Operator{}, fault.New("business_admin_denied", 403)
	}
	role := "reader"
	if id == "go-admin" {
		role = "administrator"
	}
	return Operator{ID: id, Role: role, CanManage: id == "go-admin"}, nil
}
func nodeFixture(t *testing.T, dsn string, args ...string) []byte {
	t.Helper()
	root, e := filepath.Abs(filepath.Join("..", "..", ".."))
	if e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("node", append([]string{filepath.Join(root, "scripts", "go", "feedback-fixture.mjs")}, args...)...)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	out, e := cmd.Output()
	if e != nil {
		var detail string
		if x, ok := e.(*exec.ExitError); ok {
			detail = string(x.Stderr)
		}
		t.Fatalf("original Node fixture: %v %s", e, detail)
	}
	return out
}
func normalized(t *testing.T, v any) any {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	var out any
	if e = json.Unmarshal(b, &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func encoded(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func code(t *testing.T, e error, want string) {
	t.Helper()
	if fault.Code(e) != want {
		t.Fatalf("want %s got %v", want, e)
	}
}

func TestFeedbackAgainstCurrentPostgresSchemaAndNodeProjection(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	var fixture struct {
		Accounts    []string
		Endpoint    string
		Submission  Object
		Fingerprint string
	}
	if e := json.Unmarshal(nodeFixture(t, dsn, "setup"), &fixture); e != nil {
		t.Fatal(e)
	}
	auth := &fixtureAuthority{}
	now := time.Unix(2000000000, 0)
	s := &Service{Pool: pool, Endpoint: fixture.Endpoint, Authority: auth, Now: func() time.Time { return now }}
	first, e := s.Submit(ctx, fixture.Accounts[0], encoded(t, fixture.Submission))
	if e != nil {
		t.Fatal(e)
	}
	id := first["feedbackId"].(string)
	operation := fixture.Submission["operationId"].(string)
	var hash string
	if e = pool.QueryRow(ctx, "SELECT request_hash FROM operations_feedback_v1 WHERE id=$1", id).Scan(&hash); e != nil || hash != fixture.Fingerprint {
		t.Fatalf("original fingerprint differs: %v", e)
	}
	var events int
	_ = pool.QueryRow(ctx, "SELECT count(*) FROM web_event_outbox_v1 WHERE module='feedback'").Scan(&events)
	if events < 1 {
		t.Fatal("actual business transaction produced no webpage change")
	}
	// Concurrent replay is one original operation, never a new feedback row.
	var wg sync.WaitGroup
	failures := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := s.Submit(ctx, fixture.Accounts[0], encoded(t, fixture.Submission))
			if e == nil && r["feedbackId"] != id {
				e = fault.New("duplicate_feedback", 500)
			}
			failures <- e
		}()
	}
	wg.Wait()
	close(failures)
	for e := range failures {
		if e != nil {
			t.Fatal(e)
		}
	}
	changed := Object{}
	for k, v := range fixture.Submission {
		changed[k] = v
	}
	changed["body"] = "另一段内容"
	_, e = s.Submit(ctx, fixture.Accounts[0], encoded(t, changed))
	code(t, e, "feedback_operation_conflict")
	changed["operationId"] = uuid.NewString()
	_, e = s.Submit(ctx, fixture.Accounts[0], encoded(t, changed))
	code(t, e, "feedback_rate_limited")
	receipt, e := s.SubmissionOperation(ctx, fixture.Accounts[0], operation)
	if e != nil || receipt["state"] != "recorded" {
		t.Fatalf("receipt: %v %v", receipt, e)
	}
	foreign, e := s.SubmissionOperation(ctx, fixture.Accounts[1], operation)
	if e != nil || foreign["state"] != "not-recorded" {
		t.Fatalf("foreign receipt: %v %v", foreign, e)
	}
	other := Object{"operationId": uuid.NewString(), "body": "私聊中的附件过期提示不明确。", "module": "chat"}
	if _, e = s.Submit(ctx, fixture.Accounts[1], encoded(t, other)); e != nil {
		t.Fatal(e)
	}
	list, e := s.List(ctx, "go-admin", Query{Days: "all", Limit: 1})
	if e != nil {
		t.Fatal(e)
	}
	if list["nextAfter"] == nil {
		t.Fatal("cursor missing")
	}
	next, e := s.List(ctx, "go-admin", Query{Days: "all", Limit: 1, After: list["nextAfter"].(string)})
	if e != nil || len(next["items"].([]Object)) != 1 || next["items"].([]Object)[0]["id"] != id {
		t.Fatalf("pagination: %v %v", next, e)
	}
	update := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "state": "processing", "category": "suggestion", "note": "PRIVATE_NOTE_仅限反馈处理"}
	_, e = s.Update(ctx, "go-reader", id, encoded(t, update))
	code(t, e, "business_admin_denied")
	updated, e := s.Update(ctx, "go-admin", id, encoded(t, update))
	if e != nil {
		t.Fatal(e)
	}
	if updated["feedback"].(Object)["revision"] != 2 {
		t.Fatal("revision not advanced")
	}
	replayed, e := s.Update(ctx, "go-admin", id, encoded(t, update))
	if e != nil || replayed["replayed"] != true {
		t.Fatalf("command replay: %v %v", replayed, e)
	}
	op := update["operationId"].(string)
	r, e := s.Operation(ctx, "go-admin", id, op)
	if e != nil || r["state"] != "recorded" {
		t.Fatalf("operator receipt: %v %v", r, e)
	}
	if strings.Contains(string(encoded(t, r)), "PRIVATE_NOTE") {
		t.Fatal("private note in receipt")
	}
	_, e = s.Operation(ctx, "go-reader", id, op)
	code(t, e, "not_found")
	conflict := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "state": "closed"}
	_, e = s.Update(ctx, "go-admin", id, encoded(t, conflict))
	code(t, e, "feedback_revision_conflict")
	var notes string
	_ = pool.QueryRow(ctx, "SELECT coalesce(string_agg(selection::text||result::text,''),'') FROM business_admin_audit_v1").Scan(&notes)
	if strings.Contains(notes, "PRIVATE_NOTE") || strings.Contains(notes, "搜索结果") {
		t.Fatal("private content in general audit")
	}
	// The unchanged JS read model must display Go-written records identically.
	var original struct {
		List   Object
		Detail Object
	}
	if e = json.Unmarshal(nodeFixture(t, dsn, "read", id), &original); e != nil {
		t.Fatal(e)
	}
	list, e = s.List(ctx, "go-admin", Query{Days: "all", Limit: 1})
	if e != nil {
		t.Fatal(e)
	}
	detail, e := s.Get(ctx, "go-admin", id, "")
	if e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(normalized(t, list), normalized(t, original.List)) {
		t.Fatal("Go list differs from original Node projection")
	}
	if !reflect.DeepEqual(normalized(t, detail), normalized(t, original.Detail)) {
		t.Fatalf("Go detail differs\nGo: %s\nNode: %s", encoded(t, detail), encoded(t, original.Detail))
	}
	auth.revoked = true
	_, e = s.Get(ctx, "go-admin", id, "")
	code(t, e, "business_admin_denied")
	_, e = s.SubmissionOperation(ctx, fixture.Accounts[0], operation)
	code(t, e, "official_account_login_required")
	// A rejected attachment submission rolls back its feedback/event, not half a draft.
	auth.revoked = false
	now = now.Add(61 * time.Second)
	before := 0
	_ = pool.QueryRow(ctx, "SELECT count(*) FROM operations_feedback_v1").Scan(&before)
	missing := Object{"operationId": uuid.NewString(), "body": "附件接续", "attachments": []Reference{{ID: uuid.NewString(), SHA256: strings.Repeat("a", 64)}}}
	_, e = s.Submit(ctx, fixture.Accounts[0], encoded(t, missing))
	code(t, e, "attachment_service_unavailable")
	var after int
	_ = pool.QueryRow(ctx, "SELECT count(*) FROM operations_feedback_v1").Scan(&after)
	if after != before {
		t.Fatal("failed attachment left partial feedback")
	}
	t.Run("HTTP original paths and recovery", func(t *testing.T) {
		server := httptest.NewServer(Handler{Service: s, Identity: fixtureHTTPIdentity{auth: auth, account: fixture.Accounts[0]}})
		defer server.Close()
		call := func(method, path, body, cookie, csrf, media string) (int, Object) {
			t.Helper()
			r, e := http.NewRequest(method, server.URL+path, strings.NewReader(body))
			if e != nil {
				t.Fatal(e)
			}
			r.Header.Set("Origin", "https://web.example.invalid")
			r.Header.Set("Cookie", cookie)
			r.Header.Set("Content-Type", media)
			r.Header.Set("X-CSRF", csrf)
			response, e := http.DefaultClient.Do(r)
			if e != nil {
				t.Fatal(e)
			}
			defer response.Body.Close()
			b, e := io.ReadAll(response.Body)
			if e != nil {
				t.Fatal(e)
			}
			var out Object
			if e = json.Unmarshal(b, &out); e != nil {
				t.Fatalf("HTTP response: %s", b)
			}
			if response.Header.Get("Cache-Control") != "private, no-store" {
				t.Fatal("private response cached")
			}
			return response.StatusCode, out
		}
		status, _ := call("GET", "/v1/operations/feedback", "", "", "", "application/json")
		if status != 401 {
			t.Fatalf("unauthenticated %d", status)
		}
		status, _ = call("GET", "/v1/operations/feedback?days=all&limit=1&limit=2", "", "operator=go-admin", "", "application/json")
		if status != 400 {
			t.Fatalf("duplicate filter %d", status)
		}
		status, out := call("GET", "/v1/operations/feedback/"+id+"/operations/"+op, "", "operator=go-admin", "", "application/json")
		if status != 200 || out["state"] != "recorded" {
			t.Fatalf("HTTP original receipt %d %v", status, out)
		}
		status, _ = call("POST", "/v1/operations/feedback/"+id+"/events", string(encoded(t, update)), "operator=go-admin", "", "application/json")
		if status != 403 {
			t.Fatalf("missing csrf %d", status)
		}
		status, out = call("POST", "/v1/operations/feedback/"+id+"/events", string(encoded(t, update)), "operator=go-admin", "fixture-choice", "application/json")
		if status != 200 || out["replayed"] != true {
			t.Fatalf("HTTP command recovery %d %v", status, out)
		}
		status, _ = call("POST", "/v1/account/feedback", `{"body":"same"}`, "account=owner", "fixture-choice", "text/plain")
		if status != 415 {
			t.Fatalf("media type %d", status)
		}
		status, _ = call("POST", "/v1/account/feedback", strings.Repeat("x", 32769), "account=owner", "fixture-choice", "application/json")
		if status != 413 {
			t.Fatalf("body bound %d", status)
		}
	})
}

type fixtureHTTPIdentity struct {
	auth    *fixtureAuthority
	account string
}

func (f fixtureHTTPIdentity) Account(r *http.Request, write bool) (string, Authorization, error) {
	c, e := r.Cookie("account")
	if e != nil || c.Value != "owner" {
		return "", nil, fault.New("official_account_login_required", 401)
	}
	if write && (r.Header.Get("Origin") != "https://web.example.invalid" || r.Header.Get("X-CSRF") != "fixture-choice") {
		return "", nil, fault.New("official_account_csrf_invalid", 403)
	}
	return f.account, f.auth, nil
}
func (f fixtureHTTPIdentity) Operator(r *http.Request, write bool, _ string) (string, Authorization, error) {
	c, e := r.Cookie("operator")
	if e != nil || c.Value != "go-admin" {
		return "", nil, fault.New("operations_access_denied", 401)
	}
	if write && (r.Header.Get("Origin") != "https://web.example.invalid" || r.Header.Get("X-CSRF") != "fixture-choice") {
		return "", nil, fault.New("operations_csrf_invalid", 403)
	}
	return c.Value, f.auth, nil
}
