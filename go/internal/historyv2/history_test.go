package historyv2

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func encoded(v any) []byte {
	raw, e := protocol.EncodeJS(v)
	if e != nil {
		panic(e)
	}
	return raw
}
func node(t *testing.T, dsn, mode, path string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/historyv2/testdata/interop.mjs"), mode, path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader(encoded(input))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, e := cmd.Output()
	if e != nil {
		t.Fatalf("original History v2 %s: %v %s", mode, e, stderr.String())
	}
	var out Object
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if json.Unmarshal(line, &out) == nil && out != nil {
			return out
		}
	}
	t.Fatal("fixture result")
	return nil
}
func same(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(encoded(a), &x)
	_ = json.Unmarshal(encoded(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", encoded(a), encoded(b))
	}
}
func TestOriginalHistoryV2AuthorizedFactsFingerprintAndCursor(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "history-fixture.json")
	node(t, dsn, "setup", path, nil)
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var f struct {
		Endpoint string
		Clock    int64
		Owner    struct{ Subject, Token string }
		Cases    []struct {
			Root, Start, Result          Object
			Grants                       []Object
			HiddenGrant, CorrectionGrant Object
		}
		First Object
	}
	if e = json.Unmarshal(raw, &f); e != nil {
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
	cs := &cases.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	rs := &verificationrecords.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Now: now}
	es := &evidence.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	ps := &evidence.ProofService{Evidence: es, CaseContext: cs.ProofCaseContextWithin}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Records: rs, Proofs: ps, Profiles: &profiles.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}, Now: now}
	a, e := devices.Authenticate(ctx, f.Owner.Token, "history")
	if e != nil {
		t.Fatal(e)
	}
	query := Object{"subjectId": f.Owner.Subject, "limit": 1}
	compare := func(actor *deviceauth.Actor, input Object) Object {
		t.Helper()
		who := actor != nil
		want := obj(arr(node(t, dsn, "read", path, []any{Object{"actor": who, "input": input}})["results"])[0])
		got, e := s.Query(ctx, actor, encoded(input))
		if e != nil {
			if fault.Code(e) != want["error"] || float64(fault.Status(e)) != want["status"] {
				t.Fatalf("Go %v JS %v", e, want)
			}
			return nil
		}
		if want["error"] != nil {
			t.Fatalf("unexpected success JS=%v", want)
		}
		same(t, got, want["value"])
		return got
	}
	page := compare(nil, query)
	compare(&a, query)
	if page["nextCursor"] == nil {
		t.Fatal("expected visible page cursor")
	}
	next := Object{"subjectId": f.Owner.Subject, "limit": 1, "after": page["nextCursor"]}
	compare(nil, next)
	filtered := Object{"subjectId": f.Owner.Subject, "query": "facts", "context": Object{"environment": "controlled"}, "timeWindow": Object{"kind": "90-days"}}
	compare(nil, filtered)
	if _, e = cs.SubmitV2(ctx, a, encoded(f.Cases[0].HiddenGrant), ""); e != nil {
		t.Fatal(e)
	}
	afterHidden := compare(nil, query)
	if obj(afterHidden["rebuild"])["sourceHash"] != obj(page["rebuild"])["sourceHash"] {
		t.Fatal("invisible write invalidated public fingerprint")
	}
	compare(nil, next)
	if _, e = cs.SubmitV2(ctx, a, encoded(f.Cases[0].CorrectionGrant), ""); e != nil {
		t.Fatal(e)
	}
	compare(nil, query)
	if _, e = s.Query(ctx, nil, encoded(next)); fault.Code(e) != "history_sources_changed_retry" {
		t.Fatalf("stale cursor=%v", e)
	}
	compare(nil, next)
	if _, e = owner.Exec(ctx, `UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1`, f.Cases[0].Grants[0]["consentId"], f.Clock); e != nil {
		t.Fatal(e)
	}
	compare(nil, query)
	compare(&a, query)
	if _, e = owner.Exec(ctx, `UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1`, f.Cases[0].Grants[1]["consentId"], f.Clock); e != nil {
		t.Fatal(e)
	}
	compare(nil, query)
	if _, e = owner.Exec(ctx, `UPDATE bindings SET revoked_at=to_timestamp($2) WHERE id=$1`, a.BindingID, f.Clock); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Query(ctx, &a, encoded(query)); e == nil {
		t.Fatal("revoked caller must fail transaction authorization")
	}
}
func TestOriginalHistoryV2QuerySchemaAndFingerprint(t *testing.T) {
	// Pure schema mode never connects the oracle's pool.
	dsn := "postgres://127.0.0.1:1/galaxy_go_test_history_schema"
	subject := "GUID0000000000000000000000000000"
	base := Object{"subjectId": subject}
	inputs := []any{base, Object{"subjectId": subject, "query": "  A A  ", "context": Object{"environment": " Node "}}, Object{"subjectId": subject, "recordKind": "case-history"}, Object{"subjectId": subject, "context": nil}, Object{"subjectId": subject, "timeWindow": Object{"kind": "custom", "from": "2033-05-18T03:33:20,1Z", "before": "2033-05-19T03:33:20Z"}}, Object{"subjectId": subject, "query": "a a a a a a a a a"}, Object{"subjectId": subject, "timeWindow": Object{"kind": "custom", "from": "2033-05-18T03:33:20.0001Z", "before": "2033-05-18T03:33:20.0002Z"}}}
	inputs = append(inputs, Object{"subjectId": subject, "query": strings.Repeat("😀", 200), "context": Object{"environment": strings.Repeat("😀", 160)}}, Object{"subjectId": subject, "query": strings.Repeat("😀", 201)})
	want := arr(node(t, dsn, "pure", filepath.Join(t.TempDir(), "history-fixture.json"), inputs)["values"])
	for i, input := range inputs {
		parsed, e := parseQuery(encoded(input))
		expected := obj(want[i])
		if e != nil {
			if expected["error"] != true {
				t.Fatalf("schema %d Go=%v JS=%v", i, e, expected)
			}
			continue
		}
		if expected["error"] != nil {
			t.Fatalf("unexpected accept %d", i)
		}
		same(t, parsed, expected["value"])
		q := build()
		for _, k := range parsed.Keys() {
			if k != "after" {
				q.Set(k, parsed.Values()[k])
			}
		}
		hash, e := fingerprint(q)
		if e != nil || hash != expected["hash"] {
			t.Fatalf("hash %d %s vs %v %v", i, hash, expected["hash"], e)
		}
	}
}
