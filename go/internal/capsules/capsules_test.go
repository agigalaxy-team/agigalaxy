package capsules

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func node(t *testing.T, dsn, mode, path string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/capsules/testdata/interop.mjs"), mode, path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader(encode(input))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, e := cmd.Output()
	if e != nil {
		t.Fatalf("original capsule %s %v %s", mode, e, stderr.String())
	}
	var result Object
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if json.Unmarshal(line, &result) == nil && result != nil {
			return result
		}
	}
	t.Fatal("fixture result")
	return nil
}
func same(t *testing.T, goValue, jsValue any) {
	t.Helper()
	var a, b any
	_ = json.Unmarshal(encode(goValue), &a)
	_ = json.Unmarshal(encode(jsValue), &b)
	if !reflect.DeepEqual(a, b) {
		t.Fatalf("Go=%s\nJS=%s", encode(a), encode(b))
	}
}
func TestOriginalCapsulePublicationPermissionsUseReceiptsAndCurrentSourceHTTP(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	path := filepath.Join(t.TempDir(), "capsule-fixture.json")
	node(t, dsn, "setup", path, nil)
	raw, _ := os.ReadFile(path)
	var f Object
	if e := json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	api, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	now := func() time.Time { return time.Unix(number(f, "clock"), 0) }
	endpoint := text(f, "endpoint")
	devices := &deviceauth.Service{Pool: api, Endpoint: endpoint, Now: now}
	a, e := devices.Authenticate(ctx, text(obj(f["owner"]), "token"), "capsules")
	if e != nil {
		t.Fatal(e)
	}
	b, e := devices.Authenticate(ctx, text(obj(f["other"]), "token"), "capsules")
	if e != nil {
		t.Fatal(e)
	}
	cs := &cases.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now}
	records := &verificationrecords.Service{Pool: api, Endpoint: endpoint, Devices: devices, Cases: cs, Now: now}
	cfg := &configurations.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now}
	svc := &Service{Pool: api, Endpoint: endpoint, Devices: devices, Cases: cs, Records: records, Configurations: cfg, Now: now}
	call := func(q Object) (Object, error) {
		var actor *deviceauth.Actor
		switch q["actor"] {
		case "owner":
			actor = &a
		case "other":
			actor = &b
		}
		input := encode(q["input"])
		switch q["kind"] {
		case "getV2":
			return svc.GetV2(ctx, actor, input)
		case "queryV2":
			return svc.QueryV2(ctx, actor, input)
		case "usesV2":
			return svc.UsesV2(ctx, actor, input)
		case "get":
			return svc.Get(ctx, actor, input)
		case "query":
			return svc.Query(ctx, actor, input)
		case "uses":
			return svc.Uses(ctx, actor, input)
		case "versionsV2":
			return svc.Versions(ctx, actor, input)
		case "permissionsQueryV2":
			return svc.Permissions(ctx, *actor, input)
		case "permissionReadV2":
			return svc.GetPermission(ctx, *actor, input)
		case "receiptV2":
			return svc.Receipt(ctx, *actor, input)
		case "previewV2":
			return svc.Preview(ctx, *actor, input)
		case "history":
			return postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return svc.HistoryWithin(ctx, tx, actor, text(q, "id")) })
		case "legacyHistory":
			return postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
				return svc.UsesWithin(ctx, tx, actor, Object{"caseId": q["id"], "limit": int64(20)})
			})
		case "notification":
			return postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return svc.VisibleUpdateWithin(ctx, tx, *actor, text(q, "id")) })
		}
		t.Fatal("unknown method")
		return nil, nil
	}
	compare := func(queries []any) {
		t.Helper()
		oracle := node(t, dsn, "read", path, queries)
		for i, v := range queries {
			q := obj(v)
			got, e := call(q)
			want := obj(list(oracle["results"])[i])
			if code := text(want, "error"); code != "" {
				if fault.Code(e) != code || int64(fault.Status(e)) != number(want, "status") {
					t.Fatalf("%s Go %v JS %v", q["kind"], e, want)
				}
				continue
			}
			if e != nil {
				t.Fatalf("%s %v", q["kind"], e)
			}
			same(t, got, want["value"])
			if q["kind"] == "getV2" {
				var actor *deviceauth.Actor
				if q["actor"] == "owner" {
					actor = &a
				} else if q["actor"] == "other" {
					actor = &b
				}
				_, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
					if actor != nil {
						if e := devices.AuthorizeWithin(ctx, tx, *actor, "capsules"); e != nil {
							return nil, e
						}
					}
					wire, e := svc.ReadV2WireWithin(ctx, tx, actor, obj(q["input"]))
					if e == nil && string(wire) != text(want, "wire") {
						t.Fatalf("current read ordered Go=%s\nJS=%s", wire, text(want, "wire"))
					}
					return nil, e
				})
				if e != nil {
					t.Fatal(e)
				}
			}
			if q["kind"] == "queryV2" {
				var actor *deviceauth.Actor
				if q["actor"] == "owner" {
					actor = &a
				}
				wire, e := svc.QueryV2Wire(ctx, actor, encode(q["input"]))
				if e != nil || string(wire) != text(want, "wire") {
					t.Fatalf("v2 query ordered wire %s %v", wire, e)
				}
			}
			if q["kind"] == "query" {
				wire, e := svc.QueryWire(ctx, nil, encode(q["input"]), nil)
				if e != nil || string(wire) != text(want, "wire") {
					t.Fatalf("v1 query ordered wire %s %v", wire, e)
				}
			}
			if q["kind"] == "history" || q["kind"] == "legacyHistory" {
				_, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
					var wire json.RawMessage
					var e error
					if q["kind"] == "legacyHistory" {
						wire, e = svc.LegacyHistoryWireWithin(ctx, tx, &b, text(q, "id"))
					} else {
						wire, e = svc.HistoryWireWithin(ctx, tx, &b, text(q, "id"))
					}
					if e == nil && string(wire) != text(want, "wire") {
						t.Fatalf("history ordered wire Go=%s\nJS=%s", wire, text(want, "wire"))
					}
					return nil, e
				})
				if e != nil {
					t.Fatal(e)
				}
			}
		}
	}
	base := obj(f["base"])
	compare([]any{Object{"kind": "previewV2", "actor": "owner", "input": Object{"payload": base}}})
	if _, e = svc.PublishV2(ctx, a, encode(f["versionGrant"]), ""); fault.Code(e) != "capsule_permission_unavailable" {
		t.Fatal(e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM capsules WHERE id=$1`, base["capsuleId"]).Scan(&count); e != nil || count != 0 {
		t.Fatalf("failed source publication committed parent %d %v", count, e)
	}
	if _, e = svc.Permission(ctx, b, encode(f["permissionGrant"]), ""); e != nil {
		t.Fatal(e)
	}
	published, e := svc.PublishV2(ctx, a, encode(f["versionGrant"]), "")
	if e != nil {
		t.Fatal(e)
	}
	if published["eventId"] != base["id"] {
		t.Fatal(published)
	}
	if replay, e := svc.PublishV2(ctx, a, encode(f["versionGrant"]), ""); e != nil || replay["eventId"] != base["id"] {
		t.Fatal(replay, e)
	}
	if _, e = svc.Publish(ctx, a, encode(f["legacyGrant"]), ""); e != nil {
		t.Fatal(e)
	}
	if _, e = svc.RecordUse(ctx, b, encode(f["legacyUseGrant"]), ""); e != nil {
		t.Fatal(e)
	}
	for _, key := range []string{"referenceGrant", "applyGrant", "reverifyGrant"} {
		if _, e = svc.RecordUseV2(ctx, b, encode(f[key]), ""); e != nil {
			t.Fatalf("%s %v", key, e)
		}
	}
	if _, e = svc.RecordUseV2(ctx, b, encode(f["applyGrant"]), ""); e != nil {
		t.Fatal(e)
	}
	legacyID := obj(f["legacyVersion"])["capsuleId"]
	receipt := Object{"type": "publication", "operationId": base["id"], "payloadHash": identity.Digest([]byte(text(obj(f["versionGrant"]), "payloadJson")))}
	queries := []any{Object{"kind": "getV2", "input": Object{"capsuleId": base["capsuleId"]}}, Object{"kind": "getV2", "actor": "owner", "input": Object{"capsuleId": base["capsuleId"]}}, Object{"kind": "getV2", "actor": "other", "input": Object{"capsuleId": base["capsuleId"]}}, Object{"kind": "queryV2", "input": Object{}}, Object{"kind": "usesV2", "actor": "other", "input": Object{"capsuleId": base["capsuleId"]}}, Object{"kind": "history", "actor": "other", "id": obj(obj(f["target"])["root"])["caseId"]}, Object{"kind": "get", "input": Object{"capsuleId": legacyID}}, Object{"kind": "query", "input": Object{}}, Object{"kind": "uses", "actor": "other", "input": Object{"capsuleId": legacyID}}, Object{"kind": "versionsV2", "actor": "owner", "input": Object{"capsuleId": base["capsuleId"]}}, Object{"kind": "permissionsQueryV2", "actor": "other", "input": Object{"view": "owned"}}, Object{"kind": "permissionsQueryV2", "actor": "owner", "input": Object{"view": "granted"}}, Object{"kind": "receiptV2", "actor": "owner", "input": receipt}}
	compare(queries)
	compare([]any{Object{"kind": "legacyHistory", "actor": "other", "id": obj(f["legacyUse"])["caseId"]}})
	h := Handler{Service: svc, Devices: devices}
	request := func(path string, input any, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, bytes.NewReader(encode(input)))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if response := request("/v2/capsules/read", Object{"capsuleId": base["capsuleId"]}, ""); response.Code != 200 {
		t.Fatalf("HTTP %d %s", response.Code, response.Body.String())
	}
	if response := request("/v2/capsules/receipt", receipt, ""); response.Code != 401 {
		t.Fatal(response.Code)
	}
	for _, q := range []struct {
		path  string
		input any
	}{{"/v2/capsules/events", f["versionGrant"]}, {"/v2/capsules/receipt", receipt}} {
		if response := request(q.path, q.input, text(obj(f["owner"]), "token")); response.Code != 200 {
			t.Fatalf("HTTP replay/receipt %d %s", response.Code, response.Body.String())
		}
	}
	// A private newest version never retargets an exact previous use or falls back.
	if _, e = svc.PublishV2(ctx, a, encode(f["privateGrant"]), ""); e != nil {
		t.Fatal(e)
	}
	compare([]any{Object{"kind": "getV2", "input": Object{"capsuleId": base["capsuleId"]}}, Object{"kind": "getV2", "input": Object{"capsuleId": base["capsuleId"], "versionId": base["id"]}}, Object{"kind": "usesV2", "actor": "other", "input": Object{"capsuleId": base["capsuleId"]}}})
	if _, e = svc.PublishV2(ctx, a, encode(f["noticeGrant"]), ""); e != nil {
		t.Fatal(e)
	}
	compare([]any{Object{"kind": "notification", "actor": "other", "id": obj(f["notice"])["id"]}, Object{"kind": "getV2", "actor": "owner", "input": Object{"capsuleId": base["capsuleId"], "versionId": base["id"]}}})
	if _, e = svc.Permission(ctx, b, encode(f["revokeGrant"]), ""); e != nil {
		t.Fatal(e)
	}
	compare([]any{Object{"kind": "getV2", "actor": "owner", "input": Object{"capsuleId": base["capsuleId"], "versionId": base["id"]}}, Object{"kind": "usesV2", "actor": "other", "input": Object{"capsuleId": base["capsuleId"]}}, Object{"kind": "receiptV2", "actor": "owner", "input": receipt}, Object{"kind": "permissionsQueryV2", "actor": "other", "input": Object{}}})
	// The raw accepted publication remains immutable after source withdrawal.
	var stored string
	if e = owner.QueryRow(ctx, `SELECT payload_text FROM capsule_events WHERE id=$1`, base["id"]).Scan(&stored); e != nil || stored != text(obj(f["versionGrant"]), "payloadJson") {
		t.Fatal("accepted bytes changed", e)
	}
	// Strict parser normalization is checked against the current original schema.
	schemaQueries := []any{}
	for _, entry := range []struct{ kind, key string }{{"event2", "base"}, {"use2", "apply"}, {"use2", "reverify"}, {"permission", "permission"}, {"permission", "revoke"}, {"event1", "legacyVersion"}, {"use1", "legacyUse"}} {
		schemaQueries = append(schemaQueries, Object{"kind": entry.kind, "input": f[entry.key]})
	}
	bad := Object{}
	for k, v := range base {
		bad[k] = v
	}
	bad["title"] = strings.Repeat("😀", 161)
	schemaQueries = append(schemaQueries, Object{"kind": "event2", "input": bad})
	for _, url := range []string{"https://", "https:example.org", " mailto:person@example.invalid\t ", "https://exa\nmple.invalid/path"} {
		value := Object{}
		for k, v := range base {
			value[k] = v
		}
		value["externalReferences"] = []any{Object{"url": url, "description": "Reference only", "license": nil, "inclusion": "reference-only; no-imported-body"}}
		schemaQueries = append(schemaQueries, Object{"kind": "event2", "input": value})
	}
	oracle := node(t, dsn, "schema", path, schemaQueries)
	for i, v := range schemaQueries {
		q := obj(v)
		kind := text(q, "kind")
		v2 := kind != "event1" && kind != "use1"
		purpose := "event"
		if strings.HasPrefix(kind, "use") {
			purpose = "use"
		}
		if kind == "permission" {
			purpose = "permission"
		}
		got, e := parsePayload(string(encode(q["input"])), purpose, v2)
		want := obj(list(oracle["values"])[i])
		if want["error"] == true {
			if e == nil {
				t.Fatal("accepted original-invalid schema")
			}
			continue
		}
		if e != nil {
			t.Fatal(e)
		}
		if string(encode(got)) != text(want, "wire") {
			t.Fatalf("schema ordered Go=%s\nJS=%s", encode(got), text(want, "wire"))
		}
	}
}
