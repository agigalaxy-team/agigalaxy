package identitygroups

import (
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
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	current := newCurrentGroupFixture(t, owner)
	f := current.meta
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
		if got == nil {
			t.Fatalf("%s returned no result", method)
		}
		switch method {
		case "current":
			if got["subjectId"] != obj(actors[who])["subject"] || got["endpoint"] != txt(f, "endpoint") || got["signingType"] != SignatureType {
				t.Fatalf("current control: %v", got)
			}
		case "source":
			if got["accessGranted"] != false || got["originalSubjectId"] != obj(actors[who])["subject"] {
				t.Fatalf("source authority: %v", got)
			}
		case "read":
			if got["originalIdsPreserved"] != true || got["capabilityMerged"] != false || got["accessGranted"] != false {
				t.Fatalf("group authority: %v", got)
			}
		case "query":
			if got["coverage"] != "authorized-canonical-display-groups" || got["capabilityMerged"] != false {
				t.Fatalf("query scope: %v", got)
			}
		case "resolve":
			if got["automaticIdentitySelection"] != false || got["capabilityMerged"] != false {
				t.Fatalf("identity selection: %v", got)
			}
		}
		return got
	}
	endpoint := txt(f, "endpoint")
	subject := func(w string) string { return txt(obj(actors[w]), "subject") }
	intent := func(refs any) Object {
		return Object{"schemaVersion": 2, "operationId": uuid.NewString(), "groupId": uuid.NewString(), "kind": "create", "expectedVersion": 0, "previousOperationId": nil, "endpoint": endpoint, "issuedAt": clock, "expiresAt": clock + 3600, "memberIds": []string{subject("owner"), subject("member")}, "canonicalDisplayId": subject("owner"), "visibility": "Public", "viewers": []any{}, "sourceRefs": refs, "attributionCorrections": []any{}, "purpose": "canonical-display-only", "capabilityMerged": false, "accessGranted": false}
	}
	sign := func(who string, p Object, decision string) Object {
		return current.sign(t, service, who, who, p, decision)
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
	bad := current.sign(t, service, "member", "owner", p, "approve")
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
	current.advanceOwner(t)
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
	revoked := compare("/v2/identity-groups/"+txt(p, "groupId"), "owner", "read", p["groupId"])
	if revoked["state"] != "revoked" {
		t.Fatalf("group revoke: %v", revoked)
	}

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
	if num(cleaned, "identityGroups") < 1 || num(cleaned, "identityGroupOperations") < 2 || num(cleaned, "identityGroupApprovals") < 2 {
		t.Fatalf("retention did not remove revoked group history: %v", cleaned)
	}
	var remaining int
	if e = tx.QueryRow(ctx, `SELECT count(*) FROM identity_groups_v2 WHERE id=$1`, p["groupId"]).Scan(&remaining); e != nil || remaining != 0 {
		t.Fatalf("revoked group retained: %d %v", remaining, e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
}
