package hubs

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type originalPeer struct {
	mu     sync.Mutex
	input  io.WriteCloser
	output *bufio.Reader
	meta   Object
	key    ed25519.PrivateKey
	stderr bytes.Buffer
}

func originalPeerFixture(t *testing.T, dsn, endpoint string, proof bool) *originalPeer {
	t.Helper()
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	public, e := identity.PublicPEM(pub)
	if e != nil {
		t.Fatal(e)
	}
	private, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	file := filepath.Join(t.TempDir(), "peering-fixture.json")
	raw := encode(Object{"endpoint": endpoint, "privateKeyPem": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})), "publicKeyPem": public, "includeProof": proof})
	if e = os.WriteFile(file, raw, 0600); e != nil {
		t.Fatal(e)
	}
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/hubs/testdata/peering.mjs"), file)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	p := &originalPeer{key: key}
	input, e := cmd.StdinPipe()
	if e != nil {
		t.Fatal(e)
	}
	output, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	p.input = input
	p.output = bufio.NewReader(output)
	cmd.Stderr = &p.stderr
	if e = cmd.Start(); e != nil {
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
	line, e := p.output.ReadBytes('\n')
	if e != nil {
		t.Fatal(e, p.stderr.String())
	}
	if protocol.Decode(line, &p.meta) != nil || p.meta["ready"] != true {
		t.Fatal("original peer startup")
	}
	return p
}
func (p *originalPeer) call(t *testing.T, q Object) Object {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if _, e := p.input.Write(append(encode(q), '\n')); e != nil {
		t.Fatal(e)
	}
	raw, e := p.output.ReadBytes('\n')
	if e != nil {
		t.Fatal(e, p.stderr.String())
	}
	var result Object
	if protocol.Decode(raw, &result) != nil {
		t.Fatal("original peer reply")
	}
	if result["error"] != nil {
		t.Fatal(result["error"], result["message"])
	}
	return obj(result["value"])
}

func TestPeeringTwoGoDatabasesOriginalJSProofAndUnknownScope(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	name := "galaxy_go_test_peer_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, e := owner.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); e != nil {
		t.Fatal(e)
	}
	second, e := url.Parse(dsn)
	if e != nil {
		t.Fatal(e)
	}
	second.Path = "/" + name
	secondDSN := second.String()
	left := originalPeerFixture(t, dsn, "https://a.example.invalid", false)
	right := originalPeerFixture(t, secondDSN, "https://b.example.invalid", true)
	clock := int64(2000000000)
	now := func() time.Time { return time.Unix(clock, 0) }
	type endpoint struct {
		original *originalPeer
		pool     *pgxpool.Pool
		service  *Service
		peer     *Peering
		actor    deviceauth.Actor
		server   *httptest.Server
	}
	build := func(dsn string, f *originalPeer) *endpoint {
		t.Helper()
		cfg, e := pgxpool.ParseConfig(dsn)
		if e != nil {
			t.Fatal(e)
		}
		cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
		pool, e := pgxpool.NewWithConfig(ctx, cfg)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(pool.Close)
		address := txt(f.meta, "endpoint")
		devices := &deviceauth.Service{Pool: pool, Endpoint: address, Now: now}
		cs := &cases.Service{Pool: pool, Endpoint: address, Devices: devices, Now: now}
		records := &verificationrecords.Service{Pool: pool, Endpoint: address, Devices: devices, Cases: cs, Now: now}
		pin := obj(f.meta["pin"])
		pins := map[string]deviceauth.Pin{"go-fixture": {PublicKeyPEM: txt(pin, "publicKeyPem"), NotBefore: num(pin, "notBefore"), NotAfter: num(pin, "notAfter")}}
		keyring := &deviceauth.SessionKeyring{Endpoint: address, KID: "go-fixture", Key: f.key, Pins: func() map[string]deviceauth.Pin { return pins }}
		ci := &civ2.Service{Pool: pool, Endpoint: address, Devices: devices, Records: records, Signer: keyring, Now: now}
		records.CIProofWithin = ci.ProofWithin
		bs := &builders.Service{Pool: pool, Endpoint: address, Devices: devices, Now: now}
		s := &Service{Pool: pool, Endpoint: address, Devices: devices, Builders: bs, Now: now}
		peer := &Peering{Hubs: s, CI: ci, Sharing: &contributions.Service{Pool: pool, Endpoint: address, Devices: devices, Now: now}, Pins: keyring.Pins, PinOrder: []string{"go-fixture"}, Sign: func(ctx context.Context, kind string, data any, id string, ttl int64) (string, error) {
			if kind != "hub-peering" {
				t.Fatal("signing purpose expanded")
			}
			return keyring.SignHubPeering(ctx, data, id, now().Unix(), ttl)
		}}
		a, e := devices.Authenticate(ctx, txt(f.meta, "token"), "builders")
		if e != nil {
			t.Fatal(e)
		}
		server := httptest.NewServer(Handler{Service: s, Peering: peer, Devices: devices})
		t.Cleanup(server.Close)
		return &endpoint{f, pool, s, peer, a, server}
	}
	a, b := build(dsn, left), build(secondDSN, right)
	httpCall := func(target *endpoint, path string, input any, auth bool) (int, Object) {
		t.Helper()
		r, _ := http.NewRequestWithContext(ctx, "POST", target.server.URL+path, bytes.NewReader(encode(input)))
		r.GetBody = nil
		r.Header.Set("Content-Type", "application/json")
		if auth {
			r.Header.Set("Authorization", "Bearer "+txt(target.original.meta, "token"))
		}
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		raw, e := io.ReadAll(response.Body)
		if e != nil {
			t.Fatal(e)
		}
		var value Object
		if protocol.Decode(raw, &value) != nil {
			t.Fatal("Go peer reply")
		}
		return response.StatusCode, value
	}
	ok := func(target *endpoint, path string, input any) Object {
		t.Helper()
		status, out := httpCall(target, path, input, true)
		if status != 200 {
			t.Fatal(path, status, out)
		}
		return out
	}
	agreement := Object{"profile": "galaxy-direct-proof/1", "id": uuid.NewString(), "version": 1, "parties": []any{Object{"endpoint": left.meta["endpoint"], "hubId": left.meta["hubId"], "operatorId": left.meta["subject"], "keys": []any{Object{"kid": "go-fixture", "publicKeyPem": obj(left.meta["pin"])["publicKeyPem"], "notBefore": clock - 1, "notAfter": clock + 200000}}}, Object{"endpoint": right.meta["endpoint"], "hubId": right.meta["hubId"], "operatorId": right.meta["subject"], "keys": []any{Object{"kid": "go-fixture", "publicKeyPem": obj(right.meta["pin"])["publicKeyPem"], "notBefore": clock - 1, "notAfter": clock + 200000}}}}, "sourceKinds": []any{"contribution-summary", "ci-proof-v2"}, "purpose": "help-discovery", "ratePerMinute": 60, "pageSize": 1, "expiresAt": clock + 1800, "responseMaxAgeSeconds": 120, "cache": "no-response-body-retention", "route": "direct", "officialProtocolFee": 0, "localEvaluationAuthority": "no-automatic-capability-upgrade", "rawTaskContext": "excluded", "intake": "each-party-hub-private-intake"}
	authorize := func(target *endpoint, payload Object) Object {
		t.Helper()
		return target.original.call(t, Object{"action": "authorize", "payload": payload})
	}
	approve := func(target *endpoint) {
		ev := Object{"schemaVersion": 2, "id": uuid.NewString(), "hubId": target.original.meta["hubId"], "kind": "peer-approve", "expectedVersion": 0, "agreement": agreement}
		ok(target, "/v2/hubs/peering/events", authorize(target, ev))
	}
	sends := 0
	drop := false
	var afterResponse func()
	a.peer.Send = func(ctx context.Context, address string, body []byte, timeout time.Duration, max int) ([]byte, error) {
		if address != txt(right.meta, "endpoint")+"/v2/hubs/peering/exchange" {
			t.Fatal("left selected peer")
		}
		sends++
		r, _ := http.NewRequestWithContext(ctx, "POST", b.server.URL+"/v2/hubs/peering/exchange", bytes.NewReader(body))
		r.GetBody = nil
		r.Header.Set("Content-Type", "application/json")
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			return nil, e
		}
		defer response.Body.Close()
		raw, e := io.ReadAll(response.Body)
		if response.StatusCode != 200 {
			return nil, io.ErrUnexpectedEOF
		}
		if afterResponse != nil {
			afterResponse()
		}
		if drop {
			return nil, io.ErrUnexpectedEOF
		}
		return raw, e
	}
	query := func(extra Object) Object {
		in := Object{"hubId": left.meta["hubId"], "agreementId": agreement["id"], "queryId": uuid.NewString()}
		for k, v := range extra {
			in[k] = v
		}
		return ok(a, "/v2/hubs/peering/query", in)
	}
	approve(a)
	if out := query(nil); out["state"] != "unknown" || sends != 1 {
		t.Fatal("local approval fabricated remote authority", out, sends)
	}
	approve(b)
	sourceGrant := Object{"schemaVersion": 2, "id": uuid.NewString(), "kind": "source-grant", "hubId": right.meta["hubId"], "agreementId": agreement["id"], "agreementVersion": 1, "source": right.meta["source"], "requesterIds": []any{left.meta["subject"]}, "expiresAt": clock + 1000, "purpose": "selected-peering-read-only", "disclosure": "exact-proof-or-selected-nonnarrative-contribution-fields", "redactionConfirmed": true}
	preview := ok(b, "/v2/hubs/peering/preview", Object{"hubId": right.meta["hubId"], "agreementId": agreement["id"], "source": right.meta["source"]})
	if preview["published"] != false {
		t.Fatal(preview)
	}
	grantAuth := authorize(b, sourceGrant)
	ok(b, "/v2/hubs/peering/events", grantAuth)
	page := query(nil)
	if page["remoteApproval"] != "verified-for-this-current-query" || len(arr(page["items"])) != 1 || obj(arr(page["items"])[0])["synthetic"] != true {
		t.Fatal(page)
	}
	for _, secret := range []string{txt(right.meta, "caseId"), "PRIVATE_SYNTHETIC_TITLE", "PRIVATE_SYNTHETIC_CONTEXT", "PRIVATE_SYNTHETIC_DIAGNOSIS"} {
		if strings.Contains(string(encode(page)), secret) {
			t.Fatal("private context returned")
		}
	}
	for _, q := range []struct {
		method string
		in     Object
	}{{"read", Object{"hubId": right.meta["hubId"], "agreementId": agreement["id"]}}, {"connections", Object{"hubId": right.meta["hubId"]}}, {"list", Object{"hubId": right.meta["hubId"], "kind": "grants"}}, {"preview", Object{"hubId": right.meta["hubId"], "agreementId": agreement["id"], "source": right.meta["source"]}}, {"sources", Object{"hubId": right.meta["hubId"], "kind": "case-event", "parentId": right.meta["caseId"]}}} {
		got := ok(b, "/v2/hubs/peering/"+q.method, q.in)
		want := right.call(t, Object{"action": "read", "method": q.method, "input": q.in})
		same(t, got, want)
	}
	proof := obj(right.meta["proof"])
	proofGrant := clone(sourceGrant)
	proofGrant["id"] = uuid.NewString()
	proofGrant["source"] = proof["source"]
	ok(b, "/v2/hubs/peering/events", authorize(b, proofGrant))
	proofPage := query(Object{"after": page["nextCursor"]})
	if len(arr(proofPage["items"])) != 1 || obj(arr(proofPage["items"])[0])["signed"] != obj(proof["published"])["signed"] || num(obj(arr(proofPage["sourceGroups"])[0]), "independentEvidenceAdded") != 0 {
		t.Fatal("proof bytes or provenance changed", proofPage)
	}
	// The original JS caller verifies both the Go outer signature and original CI token.
	left.call(t, Object{"action": "transport", "origin": b.server.URL, "peer": right.meta["endpoint"]})
	jsPage := left.call(t, Object{"action": "read", "method": "query", "input": Object{"hubId": left.meta["hubId"], "agreementId": agreement["id"], "queryId": uuid.NewString(), "after": page["nextCursor"]}})
	if obj(arr(jsPage["items"])[0])["signed"] != obj(proof["published"])["signed"] {
		t.Fatal("original JS rejected Go proof page")
	}
	before := sends
	drop = true
	unknownID := uuid.NewString()
	unknown := query(Object{"queryId": unknownID})
	if unknown["state"] != "unknown" || sends != before+1 {
		t.Fatal("unknown silently retried", unknown, sends)
	}
	drop = false
	// An explicit repeated read keeps the exact query operation and request hash.
	recovered := query(Object{"queryId": unknownID})
	if recovered["remoteApproval"] != "verified-for-this-current-query" || sends != before+2 {
		t.Fatal(recovered, sends)
	}
	status, conflict := httpCall(a, "/v2/hubs/peering/query", Object{"hubId": left.meta["hubId"], "agreementId": agreement["id"], "queryId": unknownID, "after": 999}, true)
	if status != 409 || conflict["error"] != "peering_query_conflict" || sends != before+2 {
		t.Fatal("original query silently changed", status, conflict, sends)
	}
	// Even a selected peer's valid signature cannot return excess private fields.
	originalSign := b.peer.Sign
	b.peer.Sign = func(ctx context.Context, kind string, data any, id string, ttl int64) (string, error) {
		raw, e := protocol.Encode(data)
		if e != nil {
			return "", e
		}
		decoded, e := wireDecode(raw)
		if e != nil {
			return "", e
		}
		items := arr(obj(decoded)["items"])
		if len(items) == 0 {
			t.Fatal("expected bounded source item")
		}
		item := items[0].(*protocol.OrderedObject)
		item.Set("privateText", "FORBIDDEN_EXTRA_PRIVATE_TEXT")
		changed, e := wireEncode(decoded)
		if e != nil {
			return "", e
		}
		return originalSign(ctx, kind, json.RawMessage(changed), id, ttl)
	}
	status, invalid := httpCall(a, "/v2/hubs/peering/query", Object{"hubId": left.meta["hubId"], "agreementId": agreement["id"], "queryId": uuid.NewString()}, true)
	if status != 409 || invalid["error"] != "peering_response_invalid" || strings.Contains(string(encode(invalid)), "FORBIDDEN_EXTRA_PRIVATE_TEXT") {
		t.Fatal("peer signature widened response", status, invalid)
	}
	b.peer.Sign = originalSign
	right.call(t, Object{"action": "revoke", "id": obj(proof["evidenceAuth"])["consentId"]})
	gone := query(Object{"after": proofPage["nextCursor"], "recheck": []any{proofGrant["id"]}})
	found := false
	for _, v := range arr(gone["items"]) {
		found = found || obj(v)["grantId"] == proofGrant["id"] && obj(v)["state"] == "unavailable" && len(obj(v)) == 2
	}
	if !found {
		t.Fatal("revoked source body reused", gone)
	}
	// Change local scope after the remote reply; no stale peer material escapes.
	exit := Object{"schemaVersion": 2, "id": uuid.NewString(), "kind": "peer-exit", "hubId": left.meta["hubId"], "agreementId": agreement["id"], "expectedVersion": 1}
	exitAuth := authorize(a, exit)
	afterResponse = func() { ok(a, "/v2/hubs/peering/events", exitAuth) }
	status, out := httpCall(a, "/v2/hubs/peering/query", Object{"hubId": left.meta["hubId"], "agreementId": agreement["id"], "queryId": uuid.NewString()}, true)
	if status != 200 || out["state"] != "unknown" || len(arr(out["items"])) != 0 {
		t.Fatal("local agreement change returned stale material", status, out)
	}
}
