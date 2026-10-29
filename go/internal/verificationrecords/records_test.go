package verificationrecords

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
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
func TestOriginalVerificationRecordsHTTPVersionsAndCurrentSources(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := setupRecords(t, owner)
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
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Now: now}
	cs.Sources = func(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref, context Object) (Object, error) {
		opts := ReferenceOptions{CaseID: str(context, "caseId")}
		if v, ok := context["visited"].(map[string]bool); ok {
			opts.Visited = v
		}
		return s.RequireReferenceWithin(ctx, tx, a, ref, opts)
	}
	a, e := devices.Authenticate(ctx, f.Owner.Token, "evidence")
	if e != nil {
		t.Fatal(e)
	}
	viewer, e := devices.Authenticate(ctx, f.Viewer.Token, "evidence")
	if e != nil {
		t.Fatal(e)
	}
	handler := Handler{Service: s, Devices: devices}
	call := func(path string, input any) (int, Object) {
		r := httptest.NewRequest("POST", path, bytes.NewReader(encode(input)))
		r.Header.Set("Authorization", "Bearer "+f.Owner.Token)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	submit := func(name string) {
		t.Helper()
		status, out := call("/v2/verification-records/submit", f.Requests[name])
		if status != 200 {
			t.Fatalf("%s %d %v", name, status, out)
		}
	}
	submit("second")
	submit("verification")
	if _, e = cs.SubmitV2(ctx, a, encode(f.InterventionGrant), ""); e != nil {
		t.Fatal(e)
	}
	submit("verification")
	receipt := Object{"type": "verification", "id": f.Verification["id"], "operationId": f.Verification["operationId"], "payloadHash": identity.Digest([]byte(str(f.Requests["verification"], "payloadJson")))}
	stage := 0
	compare := func(queries []Object) {
		t.Helper()
		var captured struct {
			Queries []Object `json:"queries"`
			Results []any    `json:"results"`
		}
		fixtureJSON(t, fmt.Sprintf("read-%d", stage), &captured)
		stage++
		same(t, queries, captured.Queries)
		expected := captured.Results
		for i, q := range queries {
			var actor *deviceauth.Actor
			if q["actor"] == "owner" {
				actor = &a
			} else if q["actor"] == "viewer" {
				actor = &viewer
			}
			var got Object
			var err error
			input := obj(q["input"])
			switch q["kind"] {
			case "receipt":
				got, err = s.Receipt(ctx, *actor, encode(input))
			case "status":
				got, err = s.Status(ctx, *actor, encode(input))
			case "record":
				got, err = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.ReadWithin(ctx, tx, actor, input) })
			case "reference":
				got, err = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
					return s.RequireReferenceWithin(ctx, tx, actor, input, ReferenceOptions{CaseID: str(f.Root, "caseId")})
				})
			case "case":
				if actor != nil {
					got, err = cs.GetV2(ctx, *actor, str(f.Root, "caseId"), []byte(`{}`))
				} else {
					got, err = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
						c, e := cs.CaseWithin(ctx, tx, str(f.Root, "caseId"))
						if e != nil {
							return nil, e
						}
						projection, e := cs.ProjectAuthorizedWithin(ctx, tx, nil, obj(c["parent"]), c["rows"].([]Object))
						if e != nil {
							return nil, e
						}
						return obj(projection["view"]), nil
					})
				}
			}
			want := obj(expected[i])
			if err != nil {
				if want["error"] != fault.Code(err) || want["status"] != float64(fault.Status(err)) {
					t.Fatalf("query %d Go=%v JS=%v", i, err, want)
				}
			} else {
				if _, ok := want["value"]; !ok {
					t.Fatalf("query %d unexpected success %s JS=%v", i, encode(got), want)
				}
				if q["kind"] == "receipt" {
					// Acceptance uses the database clock for the newly written
					// event. Compare it to that exact persisted instant while
					// keeping every other original receipt field fixed.
					var accepted time.Time
					if e := owner.QueryRow(ctx, `SELECT created_at FROM verification_events WHERE operation_id=$1`, input["operationId"]).Scan(&accepted); e != nil {
						t.Fatal(e)
					}
					obj(obj(want["value"])["receipt"])["acceptedAt"] = accepted.UTC().Format("2006-01-02T15:04:05.000Z")
				}
				same(t, got, want["value"])
				if q["kind"] == "record" {
					_, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
						raw, e := s.ReadWireWithin(ctx, tx, actor, input)
						if e != nil {
							return nil, e
						}
						if string(raw) != str(want, "wire") {
							t.Fatalf("record wire differs\nGo=%s\nJS=%s", raw, str(want, "wire"))
						}
						return nil, nil
					})
					if e != nil {
						t.Fatal(e)
					}
				}
			}
		}
	}
	queries := []Object{{"kind": "record", "actor": "owner", "input": Object{"type": "evidence", "id": f.First["id"]}}, {"kind": "record", "actor": "viewer", "input": Object{"type": "evidence", "id": f.First["id"]}}, {"kind": "record", "actor": nil, "input": Object{"type": "verification", "id": f.Verification["id"]}}, {"kind": "receipt", "actor": "owner", "input": receipt}, {"kind": "case", "actor": "owner"}, {"kind": "case", "actor": nil}, {"kind": "status", "actor": "owner", "input": Object{"refs": []any{Object{"type": "evidence", "id": f.First["id"]}, Object{"type": "evidence", "id": f.Second["id"]}, Object{"type": "verification", "id": f.Verification["id"]}}}}}
	compare(queries)
	got, e := s.Get(ctx, a, encode(Object{"type": "evidence", "id": f.First["id"]}))
	if e != nil || obj(got["record"])["summary"] != "  Exact retained raw summary  " {
		t.Fatal("raw persisted payload was normalized", got, e)
	}
	submit("firstCorrection")
	_, e = s.Submit(ctx, a, encode(f.Requests["verification"]), "")
	if fault.Code(e) != "evidence_version_changed" {
		t.Fatal("ordinary replay restored dependent text", e)
	}
	_, e = s.Submit(ctx, a, encode(f.Requests["badCorrection"]), "")
	if fault.Code(e) != "evidence_version_changed" {
		t.Fatal("unknown source accepted as nonsynthetic", e)
	}
	submit("goodCorrection")
	compare([]Object{{"kind": "record", "actor": "owner", "input": Object{"type": "evidence", "id": f.First["id"], "version": 1}}, {"kind": "record", "actor": "owner", "input": Object{"type": "verification", "id": f.Verification["id"], "version": 1}}, {"kind": "record", "actor": "viewer", "input": Object{"type": "verification", "id": f.Verification["id"]}}, {"kind": "reference", "actor": "owner", "input": Object{"kind": "evidence", "id": f.First["id"], "version": 1}}, {"kind": "case", "actor": "owner"}, {"kind": "receipt", "actor": "owner", "input": receipt}})
	submit("revoke")
	compare([]Object{{"kind": "record", "actor": "viewer", "input": Object{"type": "evidence", "id": f.First["id"], "version": 1}}, {"kind": "record", "actor": "owner", "input": Object{"type": "evidence", "id": f.First["id"], "version": 1}}, {"kind": "record", "actor": "owner", "input": Object{"type": "verification", "id": f.Verification["id"]}}})
	if _, e = devices.RevokeConsent(ctx, a, str(f.Requests["goodCorrection"], "consentId"), nil); e != nil {
		t.Fatal(e)
	}
	goodReceipt := Object{"type": "verification", "id": f.Verification["id"], "operationId": f.GoodCorrection["operationId"], "payloadHash": identity.Digest([]byte(str(f.Requests["goodCorrection"], "payloadJson")))}
	status, out := call("/v2/verification-records/receipt", goodReceipt)
	if status != 200 || out["state"] != "acknowledged" || out["currentAccessGranted"] != false || out["sourceAccessChecked"] != false {
		t.Fatal(status, out)
	}
	var audits int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action LIKE 'verification-record.%'`, a.SubjectID).Scan(&audits); e != nil || audits != 6 {
		t.Fatal("operation audit repeated", audits, e)
	}
}
