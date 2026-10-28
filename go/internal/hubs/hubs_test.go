package hubs

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func node(t *testing.T, dsn, mode, file string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	command := exec.Command("node", filepath.Join(root, "go/internal/hubs/testdata/interop.mjs"), mode, file)
	command.Dir = root
	command.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	command.Stdin = bytes.NewReader(encode(input))
	var stderr bytes.Buffer
	command.Stderr = &stderr
	raw, e := command.Output()
	if e != nil {
		t.Fatalf("original Hub fixture %s: %v %s", mode, e, stderr.String())
	}
	var out Object
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if protocol.Decode(line, &out) == nil && out != nil {
			return out
		}
	}
	t.Fatal("original output")
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
func TestHubOriginalScopeLifecycleIntakeReceiptsAndWorkerRetention(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	file := filepath.Join(t.TempDir(), "hub-fixture.json")
	node(t, dsn, "setup", file, nil)
	raw, e := os.ReadFile(file)
	if e != nil {
		t.Fatal(e)
	}
	var f Object
	if protocol.Decode(raw, &f) != nil {
		t.Fatal("fixture")
	}
	clock := num(f, "clock")
	now := func() time.Time { return time.Unix(clock, 0) }
	rolePool := func(role string) *pgxpool.Pool {
		config := owner.Config()
		config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE "+role); return e }
		p, e := pgxpool.NewWithConfig(ctx, config)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(p.Close)
		return p
	}
	api := rolePool("galaxy_api")
	devices := &deviceauth.Service{Pool: api, Endpoint: txt(f, "endpoint"), Now: now}
	bs := &builders.Service{Pool: api, Endpoint: txt(f, "endpoint"), Devices: devices, Now: now}
	s := &Service{Pool: api, Endpoint: txt(f, "endpoint"), Devices: devices, Builders: bs, Now: now}
	handler := Handler{Service: s, Devices: devices}
	drop := false
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		if r.URL.Path == "/v2/hubs/events" {
			writes++
			if drop {
				conn, _, e := w.(http.Hijacker).Hijack()
				if e == nil {
					_ = conn.Close()
				}
				return
			}
		}
		for k, v := range rec.Header() {
			for _, x := range v {
				w.Header().Add(k, x)
			}
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	}))
	defer server.Close()
	call := func(path, actor string, input any) (int, Object, error) {
		t.Helper()
		request, _ := http.NewRequestWithContext(ctx, "POST", server.URL+path, bytes.NewReader(encode(input)))
		request.GetBody = nil
		request.Header.Set("Content-Type", "application/json")
		if actor != "" {
			request.Header.Set("Authorization", "Bearer "+txt(obj(obj(f["actors"])[actor]), "token"))
		}
		response, e := http.DefaultClient.Do(request)
		if e != nil {
			return 0, nil, e
		}
		defer response.Body.Close()
		body, e := io.ReadAll(response.Body)
		var v Object
		_ = protocol.Decode(body, &v)
		return response.StatusCode, v, e
	}
	ok := func(path, actor string, input any) Object {
		t.Helper()
		code, v, e := call(path, actor, input)
		if e != nil || code != 200 {
			t.Fatal(path, code, v, e)
		}
		return v
	}
	submit := func(key string) Object {
		t.Helper()
		g := obj(obj(f["grants"])[key])
		return ok("/v2/hubs/events", txt(g, "actor"), g["input"])
	}
	compare := func(queries []any) {
		t.Helper()
		oracle := arr(node(t, dsn, "read", file, Object{"queries": queries})["results"])
		for i, raw := range queries {
			q := obj(raw)
			method := txt(q, "method")
			path := map[string]string{"get": "read", "query": "query", "manage": "manage", "members": "memberships", "intake": "intake", "receipt": "receipt"}[method]
			code, v, e := call("/v2/hubs/"+path, txt(q, "actor"), q["input"])
			expected := obj(oracle[i])
			if e != nil {
				t.Fatal(e)
			}
			if expected["error"] != nil {
				if int64(code) != num(expected, "status") || v["error"] != expected["error"] {
					t.Fatal(code, v, expected)
				}
			} else {
				if code != 200 {
					t.Fatal(code, v)
				}
				same(t, v, expected["value"])
			}
		}
	}
	hub := Object{"hubId": f["hubId"]}
	charter := submit("charter")
	same(t, charter, submit("charter"))
	compare([]any{Object{"method": "get", "input": hub}, Object{"method": "get", "actor": "member", "input": hub}, Object{"method": "manage", "actor": "owner", "input": hub}, Object{"method": "query", "input": Object{}}})
	submit("invite")
	compare([]any{Object{"method": "members", "actor": "member", "input": hub}, Object{"method": "members", "actor": "owner", "input": hub}, Object{"method": "members", "actor": "stranger", "input": hub}})
	bad := obj(obj(f["grants"])["acceptBad"])
	code, v, e := call("/v2/hubs/events", "member", bad["input"])
	if e != nil || code != 403 || v["error"] != "hub_scope_expansion" {
		t.Fatal(code, v, e)
	}
	drop = true
	g := obj(obj(f["grants"])["accept"])
	before := writes
	if _, _, e = call("/v2/hubs/events", "member", g["input"]); e == nil {
		t.Fatal("lost ACK not observed")
	}
	drop = false
	if writes != before+1 {
		t.Fatal("unknown write resent")
	}
	ev := obj(obj(f["events"])["accept"])
	locator := Object{"operationId": ev["id"], "payloadHash": identity.Digest([]byte(txt(obj(g["input"]), "payloadJson")))}
	compare([]any{Object{"method": "receipt", "actor": "member", "input": locator}, Object{"method": "receipt", "actor": "stranger", "input": locator}, Object{"method": "members", "actor": "member", "input": hub}, Object{"method": "get", "actor": "member", "input": hub}})
	submit("intake")
	submit("reply")
	compare([]any{Object{"method": "intake", "actor": "stranger", "input": hub}, Object{"method": "intake", "actor": "owner", "input": hub}, Object{"method": "intake", "actor": "member", "input": hub}})
	submit("close")
	submit("charter2")
	compare([]any{Object{"method": "members", "actor": "member", "input": hub}, Object{"method": "get", "actor": "owner", "input": Object{"hubId": f["hubId"], "version": 1}}})
	submit("suspend")
	compare([]any{Object{"method": "get", "actor": "owner", "input": hub}, Object{"method": "manage", "actor": "owner", "input": hub}})
	submit("resume")
	submit("exit")
	compare([]any{Object{"method": "members", "actor": "member", "input": hub}, Object{"method": "query", "actor": "member", "input": Object{"view": "joined"}}})
	clock += 7776001
	retention := &Service{Pool: rolePool("galaxy_evidence_worker"), Now: now}
	out, e := retention.PurgeExpired(ctx, 100)
	if e != nil || num(out, "processed") != 1 {
		t.Fatal(out, e)
	}
	var retained, content int
	if e = owner.QueryRow(ctx, "SELECT count(*),count(*) FILTER(WHERE payload_text<>'') FROM hub_events_v2 WHERE intake_id=$1", f["threadId"]).Scan(&retained, &content); e != nil || retained != 3 || content != 0 {
		t.Fatal("retention changed original ledger", retained, content, e)
	}
}
