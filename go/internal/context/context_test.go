package contextdata

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
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

type fixtureGrant struct{ Payload, Authorization, Accept, AcceptGrant, Decline, DeclineGrant, Revoke, RevokeGrant Object }

func TestOriginalContextHTTPCurrentTaskScopeAndReceipts(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	var f struct {
		Endpoint                                        string
		Clock                                           int64
		Owner, Recipient, Other                         struct{ Subject, Token string }
		Task                                            Object
		ParticipationID                                 string
		Grants, Legacy                                  []fixtureGrant
		ScopeGrant, ScopeConfirmGrant, LegacyScopeGrant Object
	}
	setupContext(t, owner, &f)
	var reads []struct {
		Input   Object   `json:"input"`
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
	clock := f.Clock
	now := func() time.Time { return time.Unix(clock, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now, CaseOwnerSource: cs.RequireOwnerSourceWithin}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	s.Participation = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, taskID, partID string) (Object, error) {
		return tasks.RequireParticipationWithin(ctx, tx, a, taskID, partID, true)
	}
	s.LegacyLoad = func(ctx context.Context, tx pgx.Tx, id string) (Object, error) {
		v, e := tasks.LegacyLoadWithin(ctx, tx, id, false)
		return Object{"row": v.Row, "paused": v.Paused}, e
	}
	actors := map[string]deviceauth.Actor{}
	tokens := map[string]string{"owner": f.Owner.Token, "recipient": f.Recipient.Token, "other": f.Other.Token}
	for who, token := range tokens {
		a, e := devices.Authenticate(ctx, token, "context")
		if e != nil {
			t.Fatal(e)
		}
		actors[who] = a
	}
	handler := Handler{Service: s, Devices: devices}
	call := func(who, method, path string, input Object) (int, Object) {
		var body *bytes.Reader
		if input == nil {
			body = bytes.NewReader(nil)
		} else {
			body = bytes.NewReader(encode(input))
		}
		r := httptest.NewRequest(method, path, body)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+tokens[who])
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		var out Object
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		return w.Code, out
	}
	must := func(who, method, path string, input Object) Object {
		t.Helper()
		status, out := call(who, method, path, input)
		if status != 200 {
			t.Fatalf("%s %d %v", path, status, out)
		}
		return out
	}
	compare := func(queries []Object) {
		t.Helper()
		if readIndex >= len(reads) {
			t.Fatal("missing captured context read")
		}
		entry := reads[readIndex]
		readIndex++
		same(t, Object{"now": clock, "queries": queries}, entry.Input)
		expected := entry.Results
		for i, q := range queries {
			a := actors[text(q, "actor")]
			v2 := q["v2"] == true
			var got Object
			var e error
			switch q["kind"] {
			case "get":
				if v2 {
					got, e = s.GetV2(ctx, a, text(q, "id"), q["metadata"] == true, "")
				} else {
					got, e = s.GetV1(ctx, a, text(q, "id"), "")
				}
			case "query":
				if v2 {
					got, e = s.QueryV2(ctx, a, encode(q["input"]), "")
				} else {
					got, e = s.QueryV1(ctx, a, encode(q["input"]), "")
				}
			case "receipt":
				if v2 {
					got, e = s.ReceiptV2(ctx, a, encode(q["input"]))
				} else {
					got, e = s.ReceiptV1(ctx, a, encode(q["input"]))
				}
			}
			want := expected[i]
			if e != nil {
				if fault.Code(e) != want["error"] || float64(fault.Status(e)) != want["status"] {
					t.Fatalf("query%d %v Go=%v JS=%v", i, q, e, want)
				}
				continue
			}
			if want["error"] != nil {
				t.Fatalf("query%d unexpected success JS=%v", i, want)
			}
			same(t, got, want["value"])
		}
	}
	get := func(who string, v2 bool, id any) Object {
		return Object{"actor": who, "v2": v2, "kind": "get", "id": id}
	}
	compare([]Object{get("owner", true, f.Grants[0].Payload["id"]), get("recipient", true, f.Grants[0].Payload["id"]), get("other", true, f.Grants[0].Payload["id"]), get("recipient", false, f.Legacy[0].Payload["id"])})
	for _, g := range f.Grants[1:3] {
		must("owner", "POST", "/v2/context/grants", g.Authorization)
	}
	replay := must("owner", "POST", "/v2/context/grants", f.Grants[1].Authorization)
	if replay["state"] != "acknowledged" || replay["contextAccessGranted"] != false {
		t.Fatal(replay)
	}
	must("owner", "POST", "/v1/context-grants", f.Legacy[1].Authorization)
	for _, g := range f.Grants[:2] {
		must("recipient", "POST", "/v2/context/"+text(g.Payload, "id")+"/events", g.AcceptGrant)
	}
	must("recipient", "POST", "/v2/context/"+text(f.Grants[2].Payload, "id")+"/events", f.Grants[2].DeclineGrant)
	must("recipient", "POST", "/v2/context/"+text(f.Grants[1].Payload, "id")+"/events", f.Grants[1].AcceptGrant)
	for _, g := range f.Legacy {
		must("recipient", "POST", "/v1/context-grants/"+text(g.Payload, "id")+"/accept", g.AcceptGrant)
	}
	receipt := Object{"grantId": f.Grants[1].Payload["id"], "eventId": f.Grants[1].Accept["id"], "payloadHash": identity.Digest([]byte(text(f.Grants[1].AcceptGrant, "payloadJson")))}
	compare([]Object{get("recipient", true, f.Grants[1].Payload["id"]), Object{"actor": "recipient", "v2": true, "kind": "get", "id": f.Grants[1].Payload["id"], "metadata": true}, get("recipient", true, f.Grants[2].Payload["id"]), get("recipient", false, f.Legacy[1].Payload["id"]), Object{"actor": "recipient", "v2": true, "kind": "receipt", "input": receipt}, Object{"actor": "other", "v2": true, "kind": "receipt", "input": receipt}, Object{"actor": "recipient", "v2": true, "kind": "query", "input": Object{"taskId": f.Task["taskId"], "limit": 1}}, Object{"actor": "recipient", "kind": "query", "input": Object{"assistanceId": f.Legacy[1].Payload["assistanceId"]}}})
	s.ResourceWrite = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, control bool, authorize func() error, op func() (Object, error)) (Object, error) {
		if e := authorize(); e != nil {
			return nil, e
		}
		if _, e := op(); e != nil {
			return nil, e
		}
		return nil, fault.New("resource_budget_exceeded", 409)
	}
	if _, e = s.CreateV2(ctx, actors["owner"], encode(f.Grants[3].Authorization), ""); fault.Code(e) != "resource_budget_exceeded" {
		t.Fatalf("rollback=%v", e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM context_grants_v2 WHERE id=$1`, f.Grants[3].Payload["id"]).Scan(&count); e != nil || count != 0 {
		t.Fatalf("rollback count=%d %v", count, e)
	}
	s.ResourceWrite = nil
	var before, after int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action='context.read'`, f.Recipient.Subject).Scan(&before); e != nil {
		t.Fatal(e)
	}
	must("recipient", "GET", "/v2/context/"+text(f.Grants[1].Payload, "id"), nil)
	must("recipient", "GET", "/v2/context/"+text(f.Grants[1].Payload, "id"), nil)
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action='context.read'`, f.Recipient.Subject).Scan(&after); e != nil || after != before+2 {
		t.Fatalf("read audit %d→%d %v", before, after, e)
	}
	if _, e = owner.Exec(ctx, `UPDATE consents SET revoked_at=to_timestamp($2) WHERE id=$1`, f.Grants[0].AcceptGrant["consentId"], clock); e != nil {
		t.Fatal(e)
	}
	compare([]Object{get("recipient", true, f.Grants[0].Payload["id"]), get("owner", true, f.Grants[0].Payload["id"])})
	var scope taskmaterials.Envelope
	_ = json.Unmarshal(encode(f.ScopeGrant), &scope)
	if _, e = tasks.SubmitParticipationEvent(ctx, taskmaterials.Actor{Actor: actors["owner"]}, f.ParticipationID, scope); e != nil {
		t.Fatal(e)
	}
	compare([]Object{get("recipient", true, f.Grants[1].Payload["id"])})
	_ = json.Unmarshal(encode(f.ScopeConfirmGrant), &scope)
	if _, e = tasks.SubmitParticipationEvent(ctx, taskmaterials.Actor{Actor: actors["recipient"]}, f.ParticipationID, scope); e != nil {
		t.Fatal(e)
	}
	compare([]Object{get("recipient", true, f.Grants[1].Payload["id"])})
	must("owner", "POST", "/v2/context/"+text(f.Grants[1].Payload, "id")+"/events", f.Grants[1].RevokeGrant)
	compare([]Object{get("recipient", true, f.Grants[1].Payload["id"]), Object{"actor": "recipient", "v2": true, "kind": "receipt", "input": receipt}})
	_ = json.Unmarshal(encode(f.LegacyScopeGrant), &scope)
	if _, e = tasks.SubmitLegacy(ctx, taskmaterials.Actor{Actor: actors["owner"]}, text(f.Legacy[0].Payload, "assistanceId"), scope); e != nil {
		t.Fatal(e)
	}
	compare([]Object{get("recipient", false, f.Legacy[0].Payload["id"])})
	must("owner", "POST", "/v1/context-grants/"+text(f.Legacy[0].Payload, "id")+"/revoke", Object{})
	compare([]Object{Object{"actor": "recipient", "kind": "receipt", "input": Object{"kind": "accept", "grantId": f.Legacy[0].Payload["id"], "eventId": f.Legacy[0].Accept["id"], "payloadHash": identity.Digest([]byte(text(f.Legacy[0].AcceptGrant, "payloadJson")))}}})
	if readIndex != len(reads) {
		t.Fatalf("unconsumed captured context reads: %d", len(reads)-readIndex)
	}
	var leaked bool
	if e = owner.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM audit_events WHERE scope='context' AND row_to_json(audit_events)::text LIKE '%Explicit original selected material%')`).Scan(&leaked); e != nil || leaked {
		t.Fatalf("audit copied selected text %v %v", leaked, e)
	}
}
