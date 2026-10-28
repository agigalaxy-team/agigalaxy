package history

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func node(t *testing.T, dsn, mode, path string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "go/internal/history/testdata/interop.mjs"), mode, path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader(encode(input))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, e := cmd.Output()
	if e != nil {
		t.Fatalf("original history %s %v %s", mode, e, stderr.String())
	}
	lines := bytes.Split(bytes.TrimSpace(out), []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		var o Object
		if json.Unmarshal(lines[i], &o) == nil && o != nil {
			return o
		}
	}
	t.Fatal("invalid history fixture result")
	return nil
}
func normal(v any) any { var out any; _ = json.Unmarshal(encode(v), &out); return out }
func same(t *testing.T, a, b any) {
	t.Helper()
	if !reflect.DeepEqual(normal(a), normal(b)) {
		t.Fatalf("history projection differs\nGo=%s\nJS=%s", encode(a), encode(b))
	}
}
func TestOriginalHistoryProjectionHashesPermissionsAndHTTP(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "history-fixture.json")
	node(t, dsn, "setup", path, nil)
	raw, _ := os.ReadFile(path)
	var f struct {
		Endpoint, PublicCase, Hidden, Shared, Later string
		Now                                         int64
		Owner, Viewer                               struct{ Subject, Token string }
		FailedGrant                                 Object
	}
	if json.Unmarshal(raw, &f) != nil {
		t.Fatal("fixture")
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(f.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: now}
	profile := &profiles.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Profiles: profile, Now: now}
	a, e := devices.Authenticate(ctx, f.Owner.Token, "history")
	if e != nil {
		t.Fatal(e)
	}
	viewer, e := devices.Authenticate(ctx, f.Viewer.Token, "history")
	if e != nil {
		t.Fatal(e)
	}
	queries := []Object{{"actor": nil, "input": Object{"subjectId": f.Owner.Subject}}, {"actor": "owner", "input": Object{"subjectId": f.Owner.Subject}}, {"actor": "viewer", "input": Object{"subjectId": f.Owner.Subject}}, {"actor": "owner", "input": Object{"subjectId": f.Owner.Subject, "environment": "node", "sourceKind": "local", "createdFrom": "2000-01-01T00:00:00Z", "createdBefore": "2100-01-01T00:00:00Z"}}, {"actor": nil, "input": Object{"subjectId": f.Owner.Subject, "query": "compiler", "limit": 1}}, {"actor": nil, "input": Object{"subjectId": f.Owner.Subject, "after": f.PublicCase, "limit": 1}}, {"actor": nil, "input": Object{"subjectId": f.Owner.Subject, "verificationStrength": "reported-only"}}, {"actor": nil, "input": Object{"subjectId": f.Owner.Subject, "capabilityId": "compiler"}}}
	expected := node(t, dsn, "query", path, queries)["results"].([]any)
	for i, q := range queries {
		var actor *deviceauth.Actor
		switch q["actor"] {
		case "owner":
			actor = &a
		case "viewer":
			actor = &viewer
		}
		got, e := s.Query(ctx, actor, encode(q["input"]))
		if e != nil {
			t.Fatalf("query %d: %v", i, e)
		}
		same(t, got, expected[i].(Object)["value"])
	}
	public, e := s.Query(ctx, nil, encode(Object{"subjectId": f.Owner.Subject}))
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(encode(public)), "private-tool") || strings.Contains(string(encode(public)), f.Hidden) {
		t.Fatal("owner-only or private fact entered public history")
	}
	// The profiles GET uses the real combined History query, not a partial
	// declaration-only success. Its signed-ID option is still scope checked.
	portal := profiles.Handler{Service: profile, Devices: devices, HistoryQuery: s.Query}
	r := httptest.NewRequest("GET", "/v1/profiles/"+f.Owner.Subject, nil)
	w := httptest.NewRecorder()
	portal.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("combined profile HTTP %d %s", w.Code, w.Body.String())
	}
	var combined Object
	_ = json.Unmarshal(w.Body.Bytes(), &combined)
	same(t, combined, public)
	handler := Handler{Service: s, Devices: devices}
	r = httptest.NewRequest("POST", "/v1/history/query", bytes.NewReader(encode(Object{"subjectId": f.Owner.Subject})))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+f.Owner.Token)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("history HTTP %d %s", w.Code, w.Body.String())
	}
	_, e = s.Query(ctx, &viewer, encode(Object{"subjectId": f.Owner.Subject, "environment": "Node"}))
	if fault.Code(e) != "history_owner_filters_required" {
		t.Fatal("foreign owner filter accepted")
	}
	if _, e = devices.RevokeConsent(ctx, a, str(f.FailedGrant, "consentId"), nil); e != nil {
		t.Fatal(e)
	}
	after, e := s.Query(ctx, nil, encode(Object{"subjectId": f.Owner.Subject}))
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range array(after["items"]) {
		if obj(v)["caseId"] == f.PublicCase {
			t.Fatal("revoked event remained in rebuilt case")
		}
	}
	expectedAfter := node(t, dsn, "query", path, []Object{{"actor": nil, "input": Object{"subjectId": f.Owner.Subject}}})["results"].([]any)[0].(Object)["value"]
	same(t, after, expectedAfter)
	// Source count/version corruption cannot be accepted as a rebuilt history.
	_, e = owner.Exec(ctx, `UPDATE cases SET version=version+1 WHERE id=$1`, f.Later)
	if e != nil {
		t.Fatal(e)
	}
	_, e = s.Query(ctx, nil, encode(Object{"subjectId": f.Owner.Subject}))
	if fault.Code(e) != "history_source_inconsistent" {
		t.Fatalf("inconsistent source accepted: %v", e)
	}
	// Reading is side-effect free: source events and original signatures persist.
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM case_events WHERE case_id=$1`, f.PublicCase).Scan(&count); e != nil || count != 7 {
		t.Fatalf("history rewrote source events %d %v", count, e)
	}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return s.QueryCandidatesWithin(ctx, tx, nil, encode(Object{"subjectId": f.Owner.Subject}), []string{})
	})
	if e != nil {
		t.Fatal(e)
	}
}
