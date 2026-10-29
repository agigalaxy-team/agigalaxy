package configurations

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
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
func TestOriginalConfigurationHTTPVersionsHistoryAndControl(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	var f struct {
		Endpoint                                                                             string
		Clock                                                                                int64
		Owner                                                                                struct{ Subject, Token string }
		First, FirstGrant, Second, SecondGrant, Revoke, RevokeGrant, Rollback, RollbackGrant Object
	}
	setupConfigurations(t, owner, "setup", &f)
	var reads []struct {
		Input   []Object `json:"input"`
		Results []Object `json:"results"`
	}
	fixtureJSON(t, "read", &reads)
	readIndex := 0
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(f.Clock, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: now}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now, ConfigurationCondition: s.ConditionWithin}
	hs := &historyv2.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Profiles: &profiles.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}, Now: now}
	actor, e := devices.Authenticate(ctx, f.Owner.Token, "history")
	if e != nil {
		t.Fatal(e)
	}
	h := Handler{Service: s, Devices: devices}
	call := func(path string, input Object) (int, Object) {
		r := httptest.NewRequest("POST", path, bytes.NewReader(encode(input)))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+f.Owner.Token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	compare := func(kind string, a *deviceauth.Actor, input Object) {
		t.Helper()
		if readIndex >= len(reads) {
			t.Fatal("missing captured read")
		}
		entry := reads[readIndex]
		readIndex++
		same(t, []Object{{"kind": kind, "actor": a != nil, "input": input}}, entry.Input)
		want := entry.Results[0]
		var got Object
		var e error
		switch kind {
		case "get":
			got, e = s.Get(ctx, a, encode(input))
		case "query":
			got, e = s.Query(ctx, a, encode(input))
		case "versions":
			got, e = s.Versions(ctx, a, encode(input))
		case "receipt":
			got, e = s.Receipt(ctx, *a, encode(input))
		case "condition":
			got, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return s.ConditionWithin(ctx, tx, a, input) })
		case "history":
			got, e = hs.Query(ctx, a, encode(input))
		}
		if e != nil {
			if fault.Code(e) != want["error"] || float64(fault.Status(e)) != want["status"] {
				t.Fatalf("%s Go=%v JS=%v", kind, e, want)
			}
			return
		}
		if want["error"] != nil {
			t.Fatalf("unexpected success %s JS=%v", kind, want)
		}
		same(t, got, want["value"])
	}
	id := f.First["id"]
	compare("get", nil, Object{"id": id})
	compare("history", nil, Object{"subjectId": f.Owner.Subject})
	compare("history", &actor, Object{"subjectId": f.Owner.Subject})
	if status, out := call("/v2/configurations/events", f.SecondGrant); status != 200 {
		t.Fatalf("submit %d %v", status, out)
	}
	if status, out := call("/v2/configurations/events", f.SecondGrant); status != 200 || out["actualInstallationVerified"] != nil {
		t.Fatalf("original replay %d %v", status, out)
	}
	compare("get", nil, Object{"id": id})
	compare("get", nil, Object{"id": id, "version": 1})
	compare("versions", &actor, Object{"id": id, "limit": 1})
	compare("query", nil, Object{"subjectId": f.Owner.Subject})
	compare("receipt", &actor, Object{"operationId": f.Second["operationId"], "payloadHash": identity.Digest([]byte(text(f.SecondGrant, "payloadJson")))})
	compare("condition", nil, Object{"id": id, "version": 1})
	compare("history", nil, Object{"subjectId": f.Owner.Subject})
	s.ResourceWrite = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, control bool, authorize func() error, operation func() (Object, error)) (Object, error) {
		if e := authorize(); e != nil {
			return nil, e
		}
		if _, e := operation(); e != nil {
			return nil, e
		}
		return nil, fault.New("resource_budget_exceeded", 413)
	}
	if _, e = s.Submit(ctx, actor, encode(f.RollbackGrant), ""); fault.Code(e) != "resource_budget_exceeded" {
		t.Fatalf("rollback=%v", e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM configuration_objects WHERE id=$1`, f.Rollback["id"]).Scan(&count); e != nil || count != 0 {
		t.Fatalf("rollback count=%d %v", count, e)
	}
	var usedControl bool
	s.ResourceWrite = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, control bool, authorize func() error, operation func() (Object, error)) (Object, error) {
		usedControl = control
		if e := authorize(); e != nil {
			return nil, e
		}
		return operation()
	}
	if status, out := call("/v2/configurations/events", f.RevokeGrant); status != 200 || !usedControl {
		t.Fatalf("revoke %d %v control=%v", status, out, usedControl)
	}
	compare("get", nil, Object{"id": id, "version": 1})
	compare("history", nil, Object{"subjectId": f.Owner.Subject})
	compare("condition", nil, Object{"id": id, "version": 1})
	if _, e = owner.Exec(ctx, `UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1`, f.FirstGrant["consentId"], f.Clock); e != nil {
		t.Fatal(e)
	}
	compare("get", &actor, Object{"id": id, "version": 1})
	compare("get", nil, Object{"id": id, "version": 1})
	compare("history", nil, Object{"subjectId": f.Owner.Subject})
	compare("receipt", &actor, Object{"operationId": f.Second["operationId"], "payloadHash": identity.Digest([]byte(text(f.SecondGrant, "payloadJson")))})
	var auditCount int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action='configuration.event'`, actor.SubjectID).Scan(&auditCount); e != nil || auditCount != 3 {
		t.Fatalf("audit=%d %v", auditCount, e)
	}
	samples := []any{f.First}
	for _, value := range []string{"api_key=abcdefgh", "password\u00a0:\u00a0abcdefgh", "Bearer\u2028abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----", "ordinary selected text"} {
		var copy Object
		_ = json.Unmarshal(encode(f.First), &copy)
		copy["summary"] = value
		samples = append(samples, copy)
	}
	var schemas []struct {
		Input  []any `json:"input"`
		Values []any `json:"values"`
	}
	fixtureJSON(t, "schema", &schemas)
	same(t, samples, schemas[0].Input)
	checks := schemas[0].Values
	if readIndex != len(reads) {
		t.Fatalf("unconsumed captured reads: %d", len(reads)-readIndex)
	}
	for i, sample := range samples {
		v, e := parseEvent(string(encode(sample)))
		expected := obj(checks[i])
		if e != nil {
			if expected["error"] != true {
				t.Fatalf("schema %d=%v", i, e)
			}
		} else {
			if expected["error"] != nil {
				t.Fatalf("schema %d unexpected accept", i)
			}
			same(t, v, expected["value"])
		}
	}
}
