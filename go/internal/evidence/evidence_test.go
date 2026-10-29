package evidence

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/history"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func same(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	_ = json.Unmarshal(encode(a), &x)
	_ = json.Unmarshal(encode(b), &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", encode(a), encode(b))
	}
}
func TestOriginalEvidenceProofHTTPAndTargetedWorker(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	seed := sha256.Sum256([]byte("galaxy-synthetic-evidence-signing-fixture"))
	key := ed25519.NewKeyFromSeed(seed[:])
	f := setupEvidence(t, owner)
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
	api, worker := rolePool("galaxy_api"), rolePool("galaxy_evidence_worker")
	clock := f.Clock
	now := func() time.Time { return time.Unix(clock, 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: f.Endpoint, Now: now}
	s := &Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	pins := map[string]deviceauth.Pin{}
	for _, entry := range f.Pins {
		var pair []json.RawMessage
		_ = json.Unmarshal(entry, &pair)
		var id string
		var p struct {
			PublicKeyPem        string
			NotBefore, NotAfter int64
			Revoked             bool
		}
		_ = json.Unmarshal(pair[0], &id)
		_ = json.Unmarshal(pair[1], &p)
		pins[id] = deviceauth.Pin{PublicKeyPEM: p.PublicKeyPem, NotBefore: p.NotBefore, NotAfter: p.NotAfter, Revoked: p.Revoked}
	}
	ring := &deviceauth.SessionKeyring{Endpoint: f.Endpoint, KID: "go-fixture", Key: key, Pins: func() map[string]deviceauth.Pin { return pins }}
	caseService := &cases.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	proofs := &ProofService{Evidence: s, Signer: ring, CaseContext: caseService.ProofCaseContextWithin}
	handler := Handler{Evidence: s, Proofs: proofs, Devices: devices}
	a, e := devices.Authenticate(ctx, f.Owner.Token, "evidence")
	if e != nil {
		t.Fatal(e)
	}
	call := func(method, path string, input any, authenticated bool) (int, Object) {
		r := httptest.NewRequest(method, path, bytes.NewReader(encode(input)))
		if authenticated {
			r.Header.Set("Authorization", "Bearer "+f.Owner.Token)
		}
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	// Producer failure rolls back the original Evidence and jobs rows together.
	s.Tasks = func(context.Context, pgx.Tx, string, string, string) error {
		return fault.New("synthetic_queue_failure", 503)
	}
	_, e = s.Submit(ctx, a, encode(f.ThirdGrant), "")
	if fault.Code(e) != "synthetic_queue_failure" {
		t.Fatal(e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM evidence_submissions WHERE id=$1`, f.Third["id"]).Scan(&count); e != nil || count != 0 {
		t.Fatal("producer transaction did not roll back", count, e)
	}
	s.Tasks = nil
	status, out := call("POST", "/v1/evidence-submissions", f.ThirdGrant, true)
	if status != 202 {
		t.Fatal(status, out)
	}
	status, out = call("POST", "/v1/evidence-submissions", f.ThirdGrant, true)
	if status != 202 {
		t.Fatal(status, out)
	}
	status, out = call("POST", "/v1/proof-previews", Object{"id": f.NextID, "evidenceId": f.First["id"]}, true)
	if status != 200 {
		t.Fatal(status, out)
	}
	same(t, out, f.NextPreview)
	status, published := call("POST", "/v1/proofs", f.NextGrant, true)
	if status != 200 {
		t.Fatal(status, published)
	}
	status, out = call("POST", "/v1/proofs", f.NextGrant, true)
	if status != 200 {
		t.Fatal(status, out)
	}
	same(t, out, published)
	wsvc := &Service{Pool: worker, Endpoint: f.Endpoint, Devices: devices, Now: now}
	wsvc.LockCaseState = wsvc.WorkerCaseStateWithin
	wsvc.ConsentReader = devices.RequireWorkerConsentWithin
	wsvc.Source = GithubSource{Fetch: func(ctx context.Context, address string, maxBytes int, timeout time.Duration) ([]byte, error) {
		if maxBytes != 131072 || timeout != 5*time.Second {
			t.Fatal("source request limits changed")
		}
		var id int
		switch address {
		case "https://api.github.com/repos/Fixture/Synthetic/actions/runs/12/attempts/1":
			id = 12
		case "https://api.github.com/repos/Fixture/Synthetic/actions/runs/13/attempts/1":
			id = 13
		default:
			return nil, fmt.Errorf("unexpected source route")
		}
		run, _ := protocol.DecodeOrdered([]byte(f.RunJSON))
		run.(*protocol.OrderedObject).Set("id", id)
		return protocol.EncodeJS(run)
	}}
	verify := func(ctx context.Context, reference Object, at int64) (Object, error) {
		run, e := protocol.DecodeOrdered([]byte(f.RunJSON))
		if e != nil {
			return nil, e
		}
		run.(*protocol.OrderedObject).Set("id", reference["runId"])
		return InspectGithubRun(reference, run, at)
	}
	ids := []string{}
	for _, data := range []Object{f.Second, f.Third} {
		var id string
		if e = owner.QueryRow(ctx, `SELECT id::text FROM jobs WHERE deduplication_key=$1`, "verify:"+str(data, "id")).Scan(&id); e != nil {
			t.Fatal(e)
		}
		ids = append(ids, id)
	}
	lost, e := wsvc.ProcessJob(ctx, ids[0], func(ctx context.Context, ref Object, at int64) (Object, error) {
		if _, e := owner.Exec(ctx, `UPDATE jobs SET lease_id=$2 WHERE id=$1`, ids[0], uuid.NewString()); e != nil {
			return nil, e
		}
		return verify(ctx, ref, at)
	})
	if e != nil || lost.Result["leaseLost"] != true {
		t.Fatal(lost, e)
	}
	if _, e = owner.Exec(ctx, `UPDATE jobs SET locked_until=to_timestamp($2) WHERE id=$1`, ids[0], clock-1); e != nil {
		t.Fatal(e)
	}
	result, e := wsvc.ProcessJob(ctx, ids[0], nil)
	if e != nil || result.Result["state"] != "observed" {
		t.Fatal(result, e)
	}
	result, e = wsvc.ProcessJob(ctx, ids[1], func(context.Context, Object, int64) (Object, error) {
		return Object{"status": "observed", "capabilitiesVerified": true}, nil
	})
	if e != nil || result.Result["state"] != "unavailable" || result.RetryAt.Unix() != clock+20 {
		t.Fatal(result, e)
	}
	calls := 0
	early, e := wsvc.ProcessJob(ctx, ids[1], func(context.Context, Object, int64) (Object, error) {
		calls++
		return nil, fmt.Errorf("must not run before due")
	})
	if e != nil || early.Result["processed"] != false || early.RetryAt != result.RetryAt || calls != 0 {
		t.Fatal(early, e)
	}
	clock += 20
	result, e = wsvc.ProcessJob(ctx, ids[1], nil)
	if e != nil || result.Result["state"] != "observed" {
		t.Fatal(result, e)
	}
	// Original JS reads both the Go signature and the Go worker observation.
	clock = f.Clock
	expected := fixtureValue(t, "read")
	for _, entry := range []struct{ id, key string }{{f.SeedID, "seed"}, {f.NextID, "next"}} {
		status, out = call("GET", "/v1/proofs/"+entry.id, nil, false)
		if status != 200 {
			t.Fatal(status, out)
		}
		same(t, out, expected[entry.key])
		_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
			raw, e := proofs.ReadWireWithin(ctx, tx, nil, entry.id, false)
			if e != nil {
				return nil, e
			}
			if string(raw) != str(expected, entry.key+"Wire") {
				t.Fatalf("proof wire differs\nGo=%s\nJS=%s", raw, str(expected, entry.key+"Wire"))
			}
			return nil, nil
		})
		if e != nil {
			t.Fatal(e)
		}
	}
	historyService := &history.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now, Proofs: func(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (json.RawMessage, error) {
		return proofs.ReadWireWithin(ctx, tx, a, id, false)
	}}
	historyView, e := historyService.Query(ctx, nil, encode(Object{"subjectId": f.Owner.Subject}))
	if e != nil {
		t.Fatal(e)
	}
	same(t, historyView, expected["history"])
	for _, entry := range []struct {
		data Object
		key  string
	}{{f.Second, "second"}, {f.Third, "third"}} {
		got, e := s.Get(ctx, a, str(entry.data, "id"))
		if e != nil {
			t.Fatal(e)
		}
		same(t, got, expected[entry.key])
	}
	// Same original source becoming pending removes public Proof availability.
	var firstJob string
	if e = owner.QueryRow(ctx, `SELECT id::text FROM jobs WHERE deduplication_key=$1`, "verify:"+str(f.First, "id")).Scan(&firstJob); e != nil {
		t.Fatal(e)
	}
	_, e = owner.Exec(ctx, `UPDATE jobs SET state='pending' WHERE id=$1`, firstJob)
	if e != nil {
		t.Fatal(e)
	}
	status, out = call("GET", "/v1/proofs/"+f.NextID, nil, false)
	if status != 404 {
		t.Fatal(status, out)
	}
	_, _ = owner.Exec(ctx, `UPDATE jobs SET state='completed' WHERE id=$1`, firstJob)
	p := pins["go-fixture"]
	p.Revoked = true
	pins["go-fixture"] = p
	status, out = call("GET", "/v1/proofs/"+f.NextID, nil, false)
	if status != 404 {
		t.Fatal(status, out)
	}
	p.Revoked = false
	pins["go-fixture"] = p
	status, out = call("POST", "/v1/proofs/"+f.NextID+"/revoke", Object{}, true)
	if status != 200 {
		t.Fatal(status, out)
	}
	status, out = call("GET", "/v1/proofs/"+f.NextID+"/status", nil, false)
	if status != 404 {
		t.Fatal(status, out)
	}
	var attempts int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM verification_attempts WHERE job_id=$1`, ids[0]).Scan(&attempts); e != nil || attempts != 1 {
		t.Fatal("lost lease wrote an observation", attempts, e)
	}
	fourth := f.Fourth
	var exhaustedID string
	if e = owner.QueryRow(ctx, `SELECT id::text FROM jobs WHERE deduplication_key=$1`, "verify:"+str(fourth, "id")).Scan(&exhaustedID); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE jobs SET state='running',attempts=5,lease_id=$2,locked_until=to_timestamp($3) WHERE id=$1`, exhaustedID, uuid.NewString(), clock-1); e != nil {
		t.Fatal(e)
	}
	recovered, e := wsvc.RecoverExpired(ctx)
	if e != nil || recovered["exhausted"] != 1 || recovered["unavailable"] != 1 {
		t.Fatal(recovered, e)
	}
	recovered, e = wsvc.RecoverExpired(ctx)
	if e != nil || recovered["exhausted"] != 0 || recovered["unavailable"] != 0 {
		t.Fatal("exhausted recovery repeated original transition", recovered, e)
	}
	var exhaustedAttempts int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM verification_attempts WHERE job_id=$1`, exhaustedID).Scan(&exhaustedAttempts); e != nil || exhaustedAttempts != 0 {
		t.Fatal("recovery invented an external observation", exhaustedAttempts, e)
	}
}
