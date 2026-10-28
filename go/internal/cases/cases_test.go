package cases

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func node(t *testing.T, dsn, mode, path string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/cases/testdata/interop.mjs"), mode, path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader(encode(input))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, e := cmd.Output()
	if e != nil {
		t.Fatalf("original Case %s %v %s", mode, e, stderr.String())
	}
	var out Object
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if json.Unmarshal(line, &out) == nil && out != nil {
			return out
		}
	}
	t.Fatal("fixture output")
	return nil
}
func same(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(encode(a), &x)
	_ = json.Unmarshal(encode(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", encode(a), encode(b))
	}
}
func TestOriginalCaseLedgerHTTPTransactionsAndFacts(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "case-fixture.json")
	node(t, dsn, "setup", path, nil)
	raw, _ := os.ReadFile(path)
	var f struct {
		Endpoint                                                                    string
		Clock                                                                       int64
		Owner                                                                       struct{ Subject, Token string }
		Root, Seed, Attempt, Result, Review, Rollback, Uncreated, NewRoot, NewGrant Object
		Requests                                                                    []Object
		V2root                                                                      Object
		V2events, V2requests                                                        []Object
	}
	if e := json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(f.Clock, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: now}
	svc := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	a, e := devices.Authenticate(ctx, f.Owner.Token, "case-teaser")
	if e != nil {
		t.Fatal(e)
	}
	handler := Handler{Service: svc, Devices: devices}
	call := func(method, path string, input any) (int, Object) {
		r := httptest.NewRequest(method, path, bytes.NewReader(encode(input)))
		r.Header.Set("Authorization", "Bearer "+f.Owner.Token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	// Original JS root -> Go append. Lost ACK recovers the same operation and
	// does not append a second event or claim new current read authority.
	for i := 0; i < 3; i++ {
		status, out := call("POST", "/v1/case-events", f.Requests[i])
		if status != 200 || int(out["version"].(float64)) != i+2 {
			t.Fatalf("append %d %d %v", i, status, out)
		}
	}
	status, out := call("POST", "/v1/case-events", f.Requests[0])
	if status != 200 || out["version"] != float64(2) {
		t.Fatal(status, out)
	}
	receipt := Object{"caseId": f.Root["id"], "eventId": f.Attempt["id"], "payloadHash": identity.Digest([]byte(text(f.Requests[0], "payloadJson")))}
	status, out = call("POST", "/v2/cases/events/receipt", receipt)
	if status != 200 || out["state"] != "acknowledged" || out["currentAccessGranted"] != false {
		t.Fatal(status, out)
	}
	for _, i := range []int{3, 4} {
		_, e = svc.Submit(ctx, a, encode(f.Requests[i]), "")
		want := "version_conflict"
		if i == 4 {
			want = "review_transition_conflict"
		}
		if fault.Code(e) != want {
			t.Fatalf("expected %s got %v", want, e)
		}
	}
	_, e = svc.Submit(ctx, a, encode(f.Rollback), "")
	if fault.Code(e) != "consent_required" {
		t.Fatal(e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM cases WHERE id=$1`, f.Uncreated["id"]).Scan(&count); e != nil || count != 0 {
		t.Fatalf("provisional parent survived rollback %d %v", count, e)
	}
	status, out = call("POST", "/v1/cases", f.NewGrant)
	if status != 200 {
		t.Fatal(status, out)
	}
	for i := 0; i < 8; i++ {
		status, out := call("POST", "/v2/cases/events", f.V2requests[i])
		if status != 200 || out["caseVersion"] != float64(i+2) {
			t.Fatalf("v2 %d %d %v", i, status, out)
		}
	}
	status, out = call("POST", "/v2/cases/events", f.V2requests[0])
	if status != 200 || out["caseVersion"] != float64(2) {
		t.Fatal(status, out)
	}
	_, e = svc.SubmitV2(ctx, a, encode(f.V2requests[8]), "")
	if fault.Code(e) != "source_access_unavailable" {
		t.Fatal(e)
	}
	original := node(t, dsn, "read", path, nil)
	got, e := svc.Get(ctx, a, text(f.Root, "id"))
	if e != nil {
		t.Fatal(e)
	}
	same(t, got, original["value"])
	status, out = call("POST", "/v2/cases/"+text(f.V2root, "caseId")+"/read", Object{})
	if status != 200 {
		t.Fatal(status, out)
	}
	same(t, out, original["v2"])
	if object(out["resolution"])["currentSupport"] != "referenced-result-superseded" {
		t.Fatal("corrected result revived prior resolution", out)
	}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		if e := svc.RequireOwnedCaseLiveWithin(ctx, tx, a, text(f.Root, "id")); e != nil {
			return nil, e
		}
		c, e := svc.CaseWithin(ctx, tx, text(f.Root, "id"))
		if e != nil {
			return nil, e
		}
		same(t, c["facts"], original["facts"])
		return c, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	_, e = owner.Exec(ctx, `UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1`, f.V2requests[7]["consentId"], f.Clock)
	if e != nil {
		t.Fatal(e)
	}
	expected := node(t, dsn, "v2", path, nil)
	got, e = svc.GetV2(ctx, a, text(f.V2root, "caseId"), []byte(`{}`))
	if e != nil {
		t.Fatal(e)
	}
	same(t, got, expected["v2"])
	intervention := object(list(got["interventions"])[0])
	if object(intervention["responseCoverage"])["complete"] != false || len(list(intervention["responses"])) != 0 {
		t.Fatal("hidden later response revived older opinion", intervention)
	}
	// Revocation removes aggregate reading while the exact caller receipt stays
	// acknowledged. The row and original bytes are retained unchanged.
	_, e = owner.Exec(ctx, `UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1`, f.Requests[1]["consentId"], f.Clock)
	if e != nil {
		t.Fatal(e)
	}
	_, e = svc.Get(ctx, a, text(f.Root, "id"))
	if fault.Code(e) != "consent_required" {
		t.Fatal(e)
	}
	status, out = call("POST", "/v2/cases/events/receipt", receipt)
	if status != 200 || out["state"] != "acknowledged" {
		t.Fatal(status, out)
	}
	var audits int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action LIKE 'case.%'`, a.SubjectID).Scan(&audits); e != nil || audits != 14 {
		t.Fatalf("audit once per accepted operation %d %v", audits, e)
	}
}
