package identitygroups

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
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

func enc(v any) []byte {
	b, e := protocol.Encode(v)
	if e != nil {
		panic(e)
	}
	return b
}
func same(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(enc(a), &x)
	_ = json.Unmarshal(enc(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", enc(a), enc(b))
	}
}

func TestIdentityGroupOriginalSignaturesSourcesReceiptsAndControlEpoch(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/identitygroups/testdata/interop.mjs"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	input, _ := cmd.StdinPipe()
	output, _ := cmd.StdoutPipe()
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if e := cmd.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		_ = input.Close()
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			_ = cmd.Process.Kill()
			<-done
		}
	})
	reader := bufio.NewReader(output)
	read := func() Object {
		t.Helper()
		line, e := reader.ReadBytes('\n')
		if e != nil {
			t.Fatal(e, stderr.String())
		}
		var v Object
		if e = protocol.Decode(line, &v); e != nil {
			t.Fatal(e, string(line))
		}
		return v
	}
	f := read()
	if f["ready"] != true {
		t.Fatal("fixture startup", f)
	}
	node := func(q Object) any {
		t.Helper()
		if _, e := input.Write(append(enc(q), '\n')); e != nil {
			t.Fatal(e)
		}
		v := read()
		if v["error"] != nil {
			t.Fatalf("fixture %v", v)
		}
		return v["value"]
	}
	clock := num(f, "clock")
	now := func() time.Time { return time.Unix(clock, 0) }
	role := func(name string) *pgxpool.Pool {
		c := owner.Config()
		c.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE "+name); return e }
		p, e := pgxpool.NewWithConfig(ctx, c)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(p.Close)
		return p
	}
	api := role("galaxy_api")
	devices := &deviceauth.Service{Pool: api, Endpoint: txt(f, "endpoint"), Now: now}
	configs := &configurations.Service{Pool: api, Endpoint: txt(f, "endpoint"), Devices: devices, Now: now}
	cs := &cases.Service{Pool: api, Endpoint: txt(f, "endpoint"), Devices: devices, Now: now, ConfigurationCondition: configs.ConditionWithin}
	service := &Service{Pool: api, Endpoint: txt(f, "endpoint"), Devices: devices, Cases: cs, Configurations: configs, Now: now}
	handler := Handler{Service: service, Devices: devices}
	lost := false
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		if r.URL.Path == "/v2/identity-groups/submit" {
			writes++
			if lost && rec.Code == 200 {
				lost = false
				c, _, _ := w.(http.Hijacker).Hijack()
				_ = c.Close()
				return
			}
		}
		for k, v := range rec.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	}))
	defer server.Close()
	actors := obj(f["actors"])
	request := func(method, path, who string, v any) (int, Object, error) {
		t.Helper()
		var body io.Reader
		if v != nil {
			body = bytes.NewReader(enc(v))
		}
		r, _ := http.NewRequestWithContext(ctx, method, server.URL+path, body)
		r.GetBody = nil
		r.Header.Set("Content-Type", "application/json")
		if who != "" {
			r.Header.Set("Authorization", "Bearer "+txt(obj(actors[who]), "token"))
		}
		res, e := server.Client().Do(r)
		if e != nil {
			return 0, nil, e
		}
		defer res.Body.Close()
		var out Object
		e = json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out, e
	}
	call := func(method, path, who string, v any) Object {
		t.Helper()
		code, out, e := request(method, path, who, v)
		if e != nil || code != 200 {
			t.Fatalf("%s %s: %d %s %v", method, path, code, enc(out), e)
		}
		return out
	}
	compare := func(path, who, method string, v any) Object {
		t.Helper()
		verb := "POST"
		if method == "current" || method == "read" || method == "proposal" {
			verb = "GET"
		}
		got := call(verb, path, who, v)
		same(t, got, node(Object{"action": "read", "actor": who, "method": method, "input": v}))
		return got
	}
	endpoint := txt(f, "endpoint")
	subject := func(w string) string { return txt(obj(actors[w]), "subject") }
	intent := func(refs any) Object {
		return obj(node(Object{"action": "intent", "input": Object{"schemaVersion": 2, "operationId": uuid.NewString(), "groupId": uuid.NewString(), "kind": "create", "expectedVersion": 0, "previousOperationId": nil, "endpoint": endpoint, "issuedAt": clock, "expiresAt": clock + 3600, "memberIds": []string{subject("owner"), subject("member")}, "canonicalDisplayId": subject("owner"), "visibility": "Public", "viewers": []any{}, "sourceRefs": refs, "attributionCorrections": []any{}, "purpose": "canonical-display-only", "capabilityMerged": false, "accessGranted": false}}))
	}
	sign := func(who string, p Object, decision string) Object {
		return obj(node(Object{"action": "sign", "actor": who, "input": p, "decision": decision}))
	}
	approve := func(who string, p Object) Object {
		return call("POST", "/v2/identity-groups/submit", who, sign(who, p, "approve"))
	}
	compare("/v2/identity-groups/current", "owner", "current", nil)
	refs := arr(f["refs"])
	for i, who := range []string{"owner", "member"} {
		r := clone(obj(refs[i]))
		delete(r, "sourceHash")
		delete(r, "originalSubjectId")
		got := compare("/v2/identity-groups/source", who, "source", r)
		same(t, got["ref"], refs[i])
	}
	p := intent(refs)
	p["attributionCorrections"] = []any{Object{"source": refs[0], "displaySubjectId": subject("member"), "reason": "Synthetic display correction only"}}
	original := sign("owner", p, "approve")
	lost = true
	_, _, e := request("POST", "/v2/identity-groups/submit", "owner", original)
	if e == nil || writes != 1 {
		t.Fatal("lost ACK retried or accepted", e, writes)
	}
	receipt := Object{"operationId": p["operationId"], "payloadHash": identity.Digest([]byte(txt(original, "payloadJson")))}
	acknowledged := compare("/v2/identity-groups/receipt", "owner", "receipt", receipt)
	if len(arr(acknowledged["acknowledgedProofIds"])) != 1 || acknowledged["state"] != "pending" {
		t.Fatal("own receipt", acknowledged)
	}
	if code, _, _ := request("GET", "/v2/identity-groups/operations/"+txt(p, "operationId"), "stranger", nil); code != 404 {
		t.Fatal("stranger proposal", code)
	}
	bad := obj(node(Object{"action": "sign", "actor": "member", "signer": "owner", "input": p}))
	if code, _, _ := request("POST", "/v2/identity-groups/submit", "member", bad); code != 401 {
		t.Fatal("wrong signature", code)
	}
	if got := approve("member", p); got["state"] != "committed" {
		t.Fatal("not committed", got)
	}
	mine := compare("/v2/identity-groups/"+txt(p, "groupId"), "owner", "read", p["groupId"])
	sources := arr(mine["sources"])
	first := obj(sources[0])
	if first["displaySubjectId"] != subject("member") || obj(first["record"])["actorId"] != subject("owner") || first["originalActorUnchanged"] != true {
		t.Fatal("changed original author", first)
	}
	public := compare("/v2/identity-groups/"+txt(p, "groupId"), "", "read", p["groupId"])
	for _, v := range arr(public["sources"]) {
		if obj(v)["record"] != nil {
			t.Fatal("group granted private source", v)
		}
	}
	compare("/v2/identity-groups/query", "owner", "query", Object{})
	compare("/v2/identity-groups/resolve", "", "resolve", Object{"subjectId": subject("member")})
	// A pending approval cannot use its historical epoch as current authority.
	stale := intent([]any{})
	stale["canonicalDisplayId"] = subject("member")
	approve("owner", stale)
	node(Object{"action": "bootstrap", "actor": "owner"})
	if code, _, _ := request("POST", "/v2/identity-groups/submit", "member", sign("member", stale, "approve")); code != 401 {
		t.Fatal("stale epoch approval accepted", code)
	}
	approve("owner", stale)
	if got := approve("member", stale); got["state"] != "committed" {
		t.Fatal("fresh same-operation approval", got)
	}
	var n int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM identity_group_approvals_v2 WHERE operation_id=$1 AND subject_id=$2", stale["operationId"], subject("owner")).Scan(&n); e != nil || n != 2 {
		t.Fatal("original approval lost", n, e)
	}
	resolved := compare("/v2/identity-groups/resolve", "", "resolve", Object{"subjectId": subject("member")})
	if resolved["automaticIdentitySelection"] != false || resolved["ambiguous"] != true {
		t.Fatal("automatic identity switch", resolved)
	}
	revoke := Object{"schemaVersion": 2, "operationId": uuid.NewString(), "groupId": p["groupId"], "kind": "revoke", "expectedVersion": 1, "previousOperationId": p["operationId"], "endpoint": endpoint, "issuedAt": clock, "expiresAt": clock + 3600, "reason": "Synthetic member withdrawal"}
	if got := approve("member", revoke); got["state"] != "committed" {
		t.Fatal("unilateral revoke", got)
	}
	compare("/v2/identity-groups/"+txt(p, "groupId"), "owner", "read", p["groupId"])
	expected := node(Object{"action": "cleanup", "at": clock + 181*86400})
	worker := role("galaxy_evidence_worker")
	tx, e := worker.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	cleaned, e := CleanupWithin(ctx, tx, clock+181*86400)
	if e != nil {
		t.Fatal(e)
	}
	same(t, cleaned, expected)
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
}
