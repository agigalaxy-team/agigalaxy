package builders

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
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func node(t *testing.T, dsn, mode, path string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	command := exec.Command("node", filepath.Join(root, "go/internal/builders/testdata/interop.mjs"), mode, path)
	command.Dir = root
	command.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	command.Stdin = bytes.NewReader(encode(input))
	var stderr bytes.Buffer
	command.Stderr = &stderr
	raw, e := command.Output()
	if e != nil {
		t.Fatalf("original builder fixture %s: %v %s", mode, e, stderr.String())
	}
	var result Object
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if protocol.Decode(line, &result) == nil && result != nil {
			return result
		}
	}
	t.Fatal("original fixture output")
	return nil
}
func same(t *testing.T, got, want any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(encode(got), &x)
	_ = json.Unmarshal(encode(want), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", encode(got), encode(want))
	}
}
func TestBuilderManifestSupportAndPackUseOriginalHTTPReceipts(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	file := filepath.Join(t.TempDir(), "builder-fixture.json")
	node(t, dsn, "setup", file, nil)
	raw, e := os.ReadFile(file)
	if e != nil {
		t.Fatal(e)
	}
	var fixture Object
	if protocol.Decode(raw, &fixture) != nil {
		t.Fatal("fixture")
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(num(fixture, "clock"), 0) }
	endpoint := txt(fixture, "endpoint")
	devices := &deviceauth.Service{Pool: pool, Endpoint: endpoint, Now: now}
	configs := &configurations.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now, ConfigurationCondition: configs.ConditionWithin}
	records := &verificationrecords.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Cases: cs, Now: now}
	service := &Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now, Cases: cs, Configurations: configs, VerificationRecords: records}
	handler := Handler{Service: service, Devices: devices}
	dropPath := ""
	writes := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		writes[r.URL.Path]++
		if r.URL.Path == dropPath {
			conn, _, e := w.(http.Hijacker).Hijack()
			if e == nil {
				_ = conn.Close()
			}
			return
		}
		for k, values := range rec.Header() {
			for _, v := range values {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	}))
	defer server.Close()
	call := func(path string, input Object, actor string) (int, Object, error) {
		t.Helper()
		request, _ := http.NewRequestWithContext(ctx, "POST", server.URL+path, bytes.NewReader(encode(input)))
		request.GetBody = nil
		request.Header.Set("Content-Type", "application/json")
		if actor != "" {
			request.Header.Set("Authorization", "Bearer "+txt(obj(fixture[actor]), "token"))
		}
		response, e := http.DefaultClient.Do(request)
		if e != nil {
			return 0, nil, e
		}
		defer response.Body.Close()
		raw, e := io.ReadAll(response.Body)
		var result Object
		_ = protocol.Decode(raw, &result)
		return response.StatusCode, result, e
	}
	ok := func(path string, input Object) Object {
		t.Helper()
		status, result, e := call(path, input, "owner")
		if e != nil || status != 200 {
			t.Fatal(path, status, result, e)
		}
		return result
	}
	checks := []any{}
	for _, key := range []string{"declare", "support", "manifest", "first", "second", "revoke"} {
		schema := "builderExtensionEventSchema"
		if key == "declare" {
			schema = "builderEventSchema"
		}
		if key == "first" || key == "second" || key == "revoke" {
			schema = "packUseEventSchema"
		}
		value := obj(fixture[key])
		checks = append(checks, Object{"schema": schema, "value": value})
	}
	oracle := arr(node(t, dsn, "schema", file, checks)["values"])
	for i, raw := range checks {
		check := obj(raw)
		parsed, e := parse(txt(check, "schema"), encode(check["value"]))
		if e != nil {
			t.Fatal(check["schema"], e)
		}
		same(t, parsed, obj(oracle[i])["value"])
	}
	ok("/v1/builders/events", obj(fixture["declareGrant"]))
	ok("/v2/builders/support/events", obj(fixture["supportGrant"]))
	dropPath = "/v2/builders/support/events"
	before := writes[dropPath]
	if _, _, e = call(dropPath, obj(fixture["manifestGrant"]), "owner"); e == nil {
		t.Fatal("manifest lost ACK not observed")
	}
	dropPath = ""
	if writes["/v2/builders/support/events"] != before+1 {
		t.Fatal("manifest retransmitted")
	}
	manifest := obj(fixture["manifest"])
	ok("/v1/builders/events/receipt", Object{"builderId": manifest["builderId"], "eventId": manifest["id"], "payloadHash": identity.Digest([]byte(txt(obj(fixture["manifestGrant"]), "payloadJson")))})
	compare := func(queries []any) {
		t.Helper()
		expected := arr(node(t, dsn, "read", file, queries)["results"])
		for i, raw := range queries {
			q := obj(raw)
			actor := ""
			if q["actor"] == true {
				actor = "owner"
			}
			path := map[string]string{"manifest": "/v2/builders/pack/manifest", "support": "/v2/builders/support/read", "use-read": "/v2/builders/pack-uses/read", "use-query": "/v2/builders/pack-uses/query", "use-candidates": "/v2/builders/pack-uses/candidates", "use-receipt": "/v2/builders/pack-uses/receipt"}[txt(q, "kind")]
			status, result, e := call(path, obj(q["input"]), actor)
			if e != nil || status != 200 {
				t.Fatal(path, status, result, e)
			}
			same(t, result, obj(expected[i])["value"])
		}
	}
	compare([]any{Object{"kind": "manifest", "input": fixture["pack"]}, Object{"kind": "support", "input": Object{"builderId": manifest["builderId"]}}, Object{"kind": "support", "actor": true, "input": Object{"builderId": manifest["builderId"]}}})
	actor, e := devices.Authenticate(ctx, txt(obj(fixture["owner"]), "token"), "builders")
	if e != nil {
		t.Fatal(e)
	}
	for _, sourceSearch := range []bool{false, true} {
		input := Object{"query": "Fixture"}
		options := Object{"sourceSearch": sourceSearch, "publicOnly": true}
		oracle := node(t, dsn, "read", file, []any{Object{"kind": "query-wire", "actor": true, "input": input, "options": options}})
		want := txt(obj(obj(arr(oracle["results"])[0])["value"]), "wire")
		wire, e := service.QueryWire(ctx, &actor, encode(input), QueryOptions{SourceSearch: sourceSearch, PublicOnly: true})
		if e != nil || string(wire) != want {
			t.Fatalf("source query wire differs: %s\n%s\n%v", wire, want, e)
		}
	}
	ok("/v2/builders/pack-uses/events", obj(fixture["firstGrant"]))
	useID := obj(fixture["first"])["id"]
	compare([]any{Object{"kind": "use-read", "actor": true, "input": Object{"id": useID}}, Object{"kind": "use-read", "input": Object{"id": useID}}, Object{"kind": "use-query", "input": Object{}}, Object{"kind": "use-candidates", "actor": true, "input": Object{}}})
	dropPath = "/v2/builders/pack-uses/events"
	before = writes[dropPath]
	if _, _, e = call(dropPath, obj(fixture["secondGrant"]), "owner"); e == nil {
		t.Fatal("PackUse lost ACK not observed")
	}
	dropPath = ""
	if writes["/v2/builders/pack-uses/events"] != before+1 {
		t.Fatal("PackUse retransmitted")
	}
	receipt := Object{"operationId": obj(fixture["second"])["operationId"], "payloadHash": identity.Digest([]byte(txt(obj(fixture["secondGrant"]), "payloadJson")))}
	compare([]any{Object{"kind": "use-receipt", "actor": true, "input": receipt}, Object{"kind": "use-read", "actor": true, "input": Object{"id": useID}}})
	status, other, e := call("/v2/builders/pack-uses/receipt", receipt, "other")
	if e != nil || status != 200 || other["state"] != "absent" || other["id"] != nil {
		t.Fatal("foreign original receipt leaked", status, other, e)
	}
	ok("/v1/builders/events", obj(fixture["delistGrant"]))
	status, blocked, e := call("/v2/builders/pack-uses/events", obj(fixture["blockedGrant"]), "owner")
	if e != nil || status != 409 || blocked["error"] != "pack_use_maintenance_blocked" {
		t.Fatal(status, blocked, e)
	}
	status, _, e = call("/v2/builders/pack/export", Object{"builderId": manifest["builderId"], "manifestId": manifest["id"]}, "")
	if e != nil || status != 409 {
		t.Fatal("delisted export accepted", status, e)
	}
	ok("/v2/builders/pack-uses/events", obj(fixture["revokeGrant"]))
	compare([]any{Object{"kind": "use-read", "actor": true, "input": Object{"id": useID, "version": 1}}})
	var count int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM worker_pack_use_events WHERE use_id=$1", useID).Scan(&count); e != nil || count != 3 {
		t.Fatal("original ledger count", count, e)
	}
	var audits int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE actor=$1 AND action IN ('builder.event','worker-pack.event')", obj(fixture["owner"])["subject"]).Scan(&audits); e != nil || audits != 7 {
		t.Fatal("audit context", audits, e)
	}
	bad := obj(fixture["support"])
	bad = clone(bad)
	support := clone(obj(bad["support"]))
	support["objectActions"] = []any{"case.read", "case.read"}
	bad["support"] = support
	if _, e = parse("builderExtensionEventSchema", encode(bad)); e == nil {
		t.Fatal("duplicate declared scopes accepted")
	}
	if _, e = parse("builderQuerySchema", []byte(`{"query":"`+strings.Repeat("x", 201)+`"}`)); e == nil {
		t.Fatal("source query bound ignored")
	}
}
