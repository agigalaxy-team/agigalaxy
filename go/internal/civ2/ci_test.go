package civ2

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
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
func TestOriginalCIHTTPProofAndRequestBoundWorker(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	seed := sha256.Sum256([]byte("galaxy-synthetic-ci-signing-fixture"))
	key := ed25519.NewKeyFromSeed(seed[:])
	f := setupCI(t, owner)
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
	cs := &cases.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	records := &verificationrecords.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Now: now}
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
	signer := &deviceauth.SessionKeyring{Endpoint: f.Endpoint, KID: "go-fixture", Key: key, Pins: func() map[string]deviceauth.Pin { return pins }}
	s := &Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Records: records, Signer: signer, Now: now}
	records.CIProofWithin = s.ProofWithin
	a, e := devices.Authenticate(ctx, f.Owner.Token, "evidence")
	if e != nil {
		t.Fatal(e)
	}
	handler := Handler{Service: s, Devices: devices}
	call := func(method, path string, input any, auth bool) (int, Object) {
		r := httptest.NewRequest(method, path, bytes.NewReader(encode(input)))
		r.Header.Set("Content-Type", "application/json")
		if auth {
			r.Header.Set("Authorization", "Bearer "+f.Owner.Token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	status, out := call("POST", "/v2/ci/proofs/preview", Object{"id": f.NextID, "requestId": f.First["id"]}, true)
	if status != 200 {
		t.Fatal(status, out)
	}
	same(t, out, f.NextPreview)
	status, published := call("POST", "/v2/ci/proofs/publish", f.NextGrant, true)
	if status != 200 {
		t.Fatal(status, published)
	}
	status, out = call("POST", "/v2/ci/proofs/publish", f.NextGrant, true)
	if status != 200 || out["signed"] != published["signed"] {
		t.Fatal(status, out)
	}
	if _, present := out["capabilityVerified"]; present {
		t.Fatal("original replay response shape changed", out)
	}
	s.Tasks = func(context.Context, pgx.Tx, string, string, string) error {
		return fault.New("synthetic_queue_failure", 503)
	}
	_, e = s.Submit(ctx, a, encode(f.SecondGrant), "")
	if fault.Code(e) != "synthetic_queue_failure" {
		t.Fatal(e)
	}
	var count int
	_ = owner.QueryRow(ctx, `SELECT count(*) FROM ci_requests_v2 WHERE id=$1`, f.Second["id"]).Scan(&count)
	if count != 0 {
		t.Fatal("CI producer failure committed request")
	}
	s.Tasks = nil
	for i := 0; i < 2; i++ {
		status, out = call("POST", "/v2/ci/requests", f.SecondGrant, true)
		if status != 200 {
			t.Fatal(status, out)
		}
	}
	status, out = call("POST", "/v2/ci/requests", f.ThirdGrant, true)
	if status != 200 {
		t.Fatal(status, out)
	}
	wsvc := &Service{Pool: worker, Endpoint: f.Endpoint, Devices: devices, Records: records, Now: now, ConsentReader: devices.RequireWorkerConsentWithin}
	wsvc.SourceReader = wsvc.WorkerSourceReader
	complete := false
	wsvc.Source = evidence.GithubSource{Fetch: func(ctx context.Context, address string, limit int, timeout time.Duration) ([]byte, error) {
		if address != "https://api.github.com/repos/Fixture/Synthetic/actions/runs/11/attempts/1" || limit != 131072 || timeout != 5*time.Second {
			t.Fatal("original CI source request changed")
		}
		run, _ := protocol.DecodeOrdered([]byte(f.RunJSON))
		if !complete {
			run.(*protocol.OrderedObject).Set("status", "in_progress")
			run.(*protocol.OrderedObject).Set("conclusion", nil)
		}
		return protocol.EncodeJS(run)
	}}
	var secondJob, thirdJob string
	if e = owner.QueryRow(ctx, `SELECT id::text FROM jobs WHERE deduplication_key=$1`, "ci-v2:"+str(f.Second, "id")).Scan(&secondJob); e != nil {
		t.Fatal(e)
	}
	if e = owner.QueryRow(ctx, `SELECT id::text FROM jobs WHERE deduplication_key=$1`, "ci-v2:"+str(f.Third, "id")).Scan(&thirdJob); e != nil {
		t.Fatal(e)
	}
	lost, e := wsvc.ProcessJob(ctx, secondJob, func(ctx context.Context, ref Object, at int64) (Object, error) {
		if _, e := owner.Exec(ctx, `UPDATE jobs SET lease_id=$2 WHERE id=$1`, secondJob, uuid.NewString()); e != nil {
			return nil, e
		}
		run, _ := protocol.DecodeOrdered([]byte(f.RunJSON))
		return evidence.InspectGithubRun(ref, run, at)
	})
	if e != nil || lost.Result["leaseLost"] != true {
		t.Fatal(lost, e)
	}
	if _, e = owner.Exec(ctx, `UPDATE jobs SET locked_until=to_timestamp($2) WHERE id=$1`, secondJob, clock-1); e != nil {
		t.Fatal(e)
	}
	queued, e := wsvc.ProcessJob(ctx, secondJob, nil)
	if e != nil || queued.Result["state"] != "observed" || queued.RetryAt.Unix() != clock+40 {
		t.Fatal(queued, e)
	}
	_, e = s.Preview(ctx, a, encode(Object{"id": uuid.NewString(), "requestId": f.Second["id"]}))
	if fault.Code(e) != "ci_observation_unavailable" {
		t.Fatal("queued CI published as completed", e)
	}
	early, e := wsvc.ProcessJob(ctx, secondJob, nil)
	if e != nil || early.Result["processed"] != false || early.RetryAt != queued.RetryAt {
		t.Fatal(early, e)
	}
	clock += 40
	complete = true
	finished, e := wsvc.ProcessJob(ctx, secondJob, nil)
	if e != nil || finished.Result["state"] != "observed" || !finished.RetryAt.IsZero() {
		t.Fatal(finished, e)
	}
	reader, e := wsvc.WorkerSourceReader(str(f.Second, "id"), f.Owner.Subject)
	if e != nil {
		t.Fatal(e)
	}
	_, e = postgres.InTx(ctx, worker, func(tx pgx.Tx) (Object, error) { return reader.CaseWithin(ctx, tx, str(f.OtherRoot, "caseId")) })
	if fault.Code(e) != "case_unavailable" {
		t.Fatal("CI reader escaped signed Case container", e)
	}
	stage := 0
	compare := func(queries []Object) {
		t.Helper()
		var capture struct {
			Input   Object `json:"input"`
			Results []any  `json:"results"`
		}
		fixtureJSON(t, fmt.Sprintf("read-%d", stage), &capture)
		stage++
		same(t, Object{"clock": clock, "queries": queries}, capture.Input)
		want := capture.Results
		for i, q := range queries {
			var got Object
			var err error
			switch q["kind"] {
			case "request":
				got, err = s.Get(ctx, a, encode(Object{"id": q["id"]}))
			case "proof":
				got, err = s.GetProof(ctx, nil, encode(Object{"id": q["id"]}))
			case "receipt":
				got, err = s.Receipt(ctx, a, encode(q["input"]))
			case "status":
				got, err = records.Status(ctx, a, encode(q["input"]))
			case "preview":
				got, err = s.Preview(ctx, a, encode(q["input"]))
			}
			expected := obj(want[i])
			if err != nil {
				if expected["error"] != fault.Code(err) || expected["status"] != float64(fault.Status(err)) {
					t.Fatalf("query %d Go=%v JS=%v", i, err, expected)
				}
			} else {
				same(t, got, expected["value"])
			}
		}
	}
	compare([]Object{{"kind": "proof", "id": f.SeedID}, {"kind": "proof", "id": f.NextID}, {"kind": "request", "id": f.Second["id"]}, {"kind": "receipt", "input": Object{"id": f.Second["id"], "type": "request"}}, {"kind": "status", "input": Object{"refs": []any{Object{"type": "ci-proof-v2", "id": f.NextID}}}}})
	revoked, e := wsvc.ProcessJob(ctx, thirdJob, func(ctx context.Context, ref Object, at int64) (Object, error) {
		if _, e := s.RevokeRequest(ctx, a, encode(Object{"id": f.Third["id"]}), ""); e != nil {
			return nil, e
		}
		run, _ := protocol.DecodeOrdered([]byte(f.RunJSON))
		return evidence.InspectGithubRun(ref, run, at)
	})
	if e != nil || revoked.Result["state"] != "revoked" {
		t.Fatal("post-I/O revoke did not replace observation", revoked, e)
	}
	if _, e = records.Submit(ctx, a, encode(f.RevokeGrant), ""); e != nil {
		t.Fatal(e)
	}
	compare([]Object{{"kind": "request", "id": f.First["id"]}, {"kind": "proof", "id": f.NextID}, {"kind": "receipt", "input": Object{"id": f.NextID, "type": "proof"}}})
	status, out = call("POST", "/v2/ci/proofs/revoke", Object{"id": f.NextID}, true)
	if status != 200 {
		t.Fatal(status, out)
	}
	status, out = call("GET", "/v2/ci/proofs/"+f.NextID+"/status", nil, false)
	if status != 404 {
		t.Fatal(status, out)
	}
	var attempts int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM ci_observations_v2 WHERE job_id=$1`, secondJob).Scan(&attempts); e != nil || attempts != 2 {
		t.Fatal("lost CI lease wrote observation", attempts, e)
	}
}
