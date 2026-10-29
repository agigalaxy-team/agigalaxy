package builders

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Exercise the current A2A SDK and portable signed contract without an old service.
func portableContract(t *testing.T, mode string, input any) Object {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(root, "go/internal/builders/testdata/portable-contract.mjs"), mode)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(encode(input))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("portable SDK contract %s: %v %s", mode, err, stderr.String())
	}
	var result Object
	if err = protocol.Decode(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestPortableCurrentSourcesOriginalVerifierAndProbeWorkerRole(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := setupBuilders(t, owner, "portable-setup")
	clock := num(f, "clock")
	now := func() time.Time { return time.Unix(clock, 0) }
	rolePool := func(role string) *pgxpool.Pool {
		c := owner.Config()
		c.AfterConnect = func(ctx context.Context, conn *pgx.Conn) error { _, e := conn.Exec(ctx, "SET ROLE "+role); return e }
		p, e := pgxpool.NewWithConfig(ctx, c)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(p.Close)
		return p
	}
	api := rolePool("galaxy_api")
	devices := &deviceauth.Service{Pool: api, Endpoint: txt(f, "endpoint"), Now: now}
	s := &Service{Pool: api, Endpoint: txt(f, "endpoint"), Devices: devices, Now: now, AssessorIDs: []string{txt(f, "assessor")}, SuitePins: []Object{obj(f["pin"])}}
	a, e := devices.Authenticate(ctx, txt(obj(f["owner"]), "token"), "builders")
	if e != nil {
		t.Fatal(e)
	}
	public, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	pub, e := identity.PublicPEM(public)
	if e != nil {
		t.Fatal(e)
	}
	captured := map[string]any{}
	s.SignConformance = func(ctx context.Context, kind string, data any, id string, ttl int64) (string, error) {
		if !contains([]string{"node-control", "conformance"}, kind) || ttl < 1 || ttl > 300 {
			t.Fatal("sign purpose/window", kind, ttl)
		}
		captured[kind] = data
		header, _ := protocol.EncodeJS(ordered("alg", "Ed25519", "typ", "galaxy-"+kind+"+jwt", "kid", "go-fixture"))
		body, _ := protocol.EncodeJS(ordered("data", data, "iss", s.Endpoint, "aud", s.Endpoint, "iat", clock, "nbf", clock, "exp", clock+ttl, "jti", id))
		b64 := base64.RawURLEncoding.EncodeToString
		input := b64(header) + "." + b64(body)
		return input + "." + b64(ed25519.Sign(key, []byte(input))), nil
	}
	nodeInput := encode(Object{"builderId": f["builderId"], "controlId": f["controlId"]})
	reportInput := encode(Object{"builderId": f["builderId"], "reportId": f["reportId"]})
	n, e := s.ExportNodeControl(ctx, a, nodeInput, "")
	if e != nil {
		t.Fatal(e)
	}
	r, e := s.ExportReport(ctx, a, reportInput, "")
	if e != nil {
		t.Fatal(e)
	}
	same(t, captured["node-control"], f["nodeSnapshot"])
	same(t, captured["conformance"], f["reportSnapshot"])
	if portableContract(t, "portable-verify", Object{"endpoint": s.Endpoint, "clock": clock, "builderId": f["builderId"], "controlId": f["controlId"], "reportId": f["reportId"], "publicKeyPem": pub, "node": n["signed"], "report": r["signed"]})["verified"] != true {
		t.Fatal("original verifier")
	}
	// Exports are reads of current authority, but every export has its own audit.
	if _, e = s.ExportNodeControl(ctx, a, nodeInput, ""); e != nil {
		t.Fatal(e)
	}
	var audits int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE action IN ('builder.node-control.export','builder.export')").Scan(&audits); e != nil || audits != 5 {
		t.Fatal(audits, e)
	}
	worker := rolePool("galaxy_evidence_worker")
	ws := &Service{Pool: worker, Endpoint: s.Endpoint, Devices: &deviceauth.Service{Pool: worker, Endpoint: s.Endpoint, Now: now}, Now: now}
	posts := 0
	var afterPost func()
	card := portableContract(t, "probe-sdk", nil)["card"]
	w := &ProbeWorker{Service: ws, Transport: ProbeTransport{Get: func(context.Context, string, int, time.Duration) ([]byte, error) {
		return encode(card), nil
	}, Post: func(ctx context.Context, address string, body []byte, max int, timeout time.Duration) ([]byte, error) {
		posts++
		var q Object
		_ = protocol.Decode(body, &q)
		if q["method"] != "GetTask" || num(obj(q["params"]), "historyLength") != 0 {
			t.Fatal("probe performed work")
		}
		result := portableContract(t, "probe-sdk", q)
		requests := arr(result["requests"])
		if len(requests) != 1 || obj(requests[0])["authorization"] != nil || obj(requests[0])["version"] != "1.0" {
			t.Fatal("original SDK request scope", requests)
		}
		if afterPost != nil {
			afterPost()
		}
		return encode(result["reply"]), nil
	}}}
	out, e := w.ProcessNext(ctx)
	if e != nil || out["state"] != "reachable" || posts != 1 {
		t.Fatal(out, posts, e)
	}
	out, e = w.ProcessNext(ctx)
	if e != nil || out["processed"] != false || posts != 1 {
		t.Fatal("completed probe repeated", out, posts, e)
	}
	clock += 61
	if _, e = s.Publish(ctx, a, encode(f["probeAgainGrant"]), ""); e != nil {
		t.Fatal(e)
	}
	afterPost = func() {
		if _, e = s.Publish(ctx, a, encode(f["delistGrant"]), ""); e != nil {
			t.Fatal(e)
		}
	}
	out, e = w.ProcessNext(ctx)
	if e != nil || out["state"] != "revoked" || posts != 2 {
		t.Fatal("source changed during I/O", out, posts, e)
	}
	s.SignConformance = nil
	if _, e = s.ExportNodeControl(ctx, a, nodeInput, ""); e == nil {
		t.Fatal("unconfigured signer exported")
	}
}
