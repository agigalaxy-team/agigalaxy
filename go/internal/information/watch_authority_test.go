package information

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"testing"
	"time"
)

type fixture struct {
	Endpoint                                                                string
	Clock                                                                   int64
	Owner                                                                   struct{ Subject, Token, BindingID string }
	Root, RootGrant, NewCase, NewCaseGrant, Task, CloseGrant, Simple, Daily Object
	Watches                                                                 []struct{ Command, Result Object }
}

func TestAcceptedWatchOpaqueAuthorityReadOnlyAndRevocation(t *testing.T) {
	owner, api, _, f := setup(t)
	ctx := context.Background()
	now := func() time.Time { return time.Unix(f.Clock, 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: f.Endpoint, Now: now}
	ordinary, e := devices.Authenticate(ctx, f.Owner.Token, "notifications")
	if e != nil {
		t.Fatal(e)
	}
	makeActor := func(index int) deviceauth.Actor {
		t.Helper()
		actor, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (deviceauth.Actor, error) {
			return devices.NewInformationWatchActor(ctx, tx, text(f.Watches[index].Command, "watchId"), f.Owner.Subject, 1)
		})
		if e != nil {
			t.Fatal(e)
		}
		return actor
	}
	a, b := makeActor(0), makeActor(1)
	authorize := func(a deviceauth.Actor, scope string) error {
		_, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return nil, devices.AuthorizeWithin(ctx, tx, a, scope) })
		return e
	}
	for _, scope := range []string{"notifications", "history", "assistance", "proof", "builders"} {
		if e = authorize(a, scope); e != nil {
			t.Fatalf("accepted scope %s: %v", scope, e)
		}
	}
	if e = authorize(a, "capsules"); e == nil {
		t.Fatal("delegate widened past its selected sources")
	}
	plain := deviceauth.Actor{SubjectID: a.SubjectID, BindingID: a.BindingID, Scopes: a.Scopes, DeviceID: a.DeviceID, KeyID: a.KeyID, ControlEpoch: a.ControlEpoch}
	if e = authorize(plain, "history"); e == nil {
		t.Fatal("ordinary actor without credential accepted")
	}
	var roundTrip deviceauth.Actor
	_ = json.Unmarshal(encode(a), &roundTrip)
	if e = authorize(roundTrip, "history"); e == nil {
		t.Fatal("opaque authority survived JSON")
	}
	cs := &cases.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	cs.ResourceWrite = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, control bool, authorize func() error, operation func() (Object, error)) (Object, error) {
		if e := deviceauth.CheckInformationWatchWrite(a, "history"); e != nil {
			return nil, e
		}
		if e := authorize(); e != nil {
			return nil, e
		}
		return operation()
	}
	if _, e = cs.SubmitV2(ctx, a, encode(f.NewCaseGrant), ""); fault.Code(e) != "information_watch_authorization_required" {
		t.Fatalf("Case delegate write=%v", e)
	}
	tasks := &taskmaterials.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	var close taskmaterials.Envelope
	_ = json.Unmarshal(encode(f.CloseGrant), &close)
	if _, e = tasks.SubmitTaskEvent(ctx, taskmaterials.Actor{Actor: a}, text(f.Task, "taskId"), close); fault.Code(e) != "information_watch_authorization_required" {
		t.Fatalf("Task delegate write=%v", e)
	}
	for _, scope := range []string{"history", "proof", "builders", "capsules", "assistance"} {
		if e = deviceauth.CheckInformationWatchWrite(a, scope); fault.Code(e) != "information_watch_authorization_required" {
			t.Fatalf("write scope %s %v", scope, e)
		}
	}
	if e = deviceauth.CheckInformationWatchWrite(a, "notifications"); e != nil {
		t.Fatal(e)
	}
	hs := &historyv2.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Cases: cs, Tasks: tasks.ReadHistoryWireWithin, Now: now}
	search := &searchv2.Service{Pool: api, Devices: devices, History: hs, Now: now}
	page, e := search.Query(ctx, &a, encode(Object{"type": "history", "query": Object{"subjectId": f.Owner.Subject}}))
	if e != nil || len(list(page["items"])) != 2 {
		t.Fatalf("real private source %v %v", page, e)
	}
	watches := &Watches{Pool: api, Devices: devices, Now: now}
	if _, e = watches.Command(ctx, ordinary, encode(Object{"operationId": "00000000-0000-4000-8000-000000000001", "watchId": f.Watches[0].Command["watchId"], "expectedRevision": 1, "action": "pause"}), ""); e != nil {
		t.Fatal(e)
	}
	if e = authorize(a, "history"); fault.Code(e) != "information_watch_authorization_required" {
		t.Fatalf("old watch revision=%v", e)
	}
	if e = authorize(b, "history"); e != nil {
		t.Fatal(e)
	}
	var originalAuthority string
	if e = owner.QueryRow(ctx, `SELECT background_authority::text FROM information_watches_v2 WHERE id=$1`, f.Watches[1].Command["watchId"]).Scan(&originalAuthority); e != nil {
		t.Fatal(e)
	}
	for _, probe := range []struct {
		field string
		value any
	}{{"controlEpoch", 0}, {"controlEpoch", 0.5}, {"controlEpoch", "0"}, {"deviceId", "00000000-0000-4000-8000-000000000001"}, {"keyId", "changed-key"}, {"keyId", 0}} {
		if _, e = owner.Exec(ctx, `UPDATE information_watches_v2 SET background_authority=jsonb_set($2::jsonb,ARRAY[$3]::text[],$4::jsonb) WHERE id=$1`, f.Watches[1].Command["watchId"], originalAuthority, probe.field, string(encode(probe.value))); e != nil {
			t.Fatal(e)
		}
		err := authorize(b, "notifications")
		// The existing JavaScript contract treats numeric zero as a falsy optional key ID.
		if probe.field == "keyId" && probe.value == 0 {
			if err != nil {
				t.Fatalf("falsy key ID contract: %v", err)
			}
			continue
		}
		if fault.Code(err) != "information_watch_authorization_required" {
			t.Fatalf("changed authority %s=%v accepted: %v", probe.field, probe.value, err)
		}
	}
	if _, e = owner.Exec(ctx, `UPDATE information_watches_v2 SET background_authority=$2::jsonb WHERE id=$1`, f.Watches[1].Command["watchId"], originalAuthority); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE bindings SET scopes=scopes-'history' WHERE id=$1`, f.Owner.BindingID); e != nil {
		t.Fatal(e)
	}
	if e = authorize(b, "notifications"); fault.Code(e) != "information_watch_authorization_required" {
		t.Fatalf("source scope removal=%v", e)
	}
	if _, e = owner.Exec(ctx, `UPDATE bindings SET scopes=scopes||'["history"]'::jsonb WHERE id=$1`, f.Owner.BindingID); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, `UPDATE access_credentials SET revoked_at=to_timestamp($2) WHERE binding_id=$1`, f.Owner.BindingID, f.Clock-1); e != nil {
		t.Fatal(e)
	}
	if e = authorize(ordinary, "history"); e == nil {
		t.Fatal("ordinary revoked credential accepted")
	}
	if e = authorize(b, "history"); e != nil {
		t.Fatalf("background incorrectly depends on temporary credential %v", e)
	}
	if _, e = owner.Exec(ctx, `UPDATE bindings SET revoked_at=to_timestamp($2) WHERE id=$1`, f.Owner.BindingID, f.Clock); e != nil {
		t.Fatal(e)
	}
	if e = authorize(b, "history"); fault.Code(e) != "information_watch_authorization_required" {
		t.Fatalf("revoked binding=%v", e)
	}
	var count int
	if e = owner.QueryRow(ctx, `SELECT count(*) FROM cases WHERE id=$1`, f.NewCase["caseId"]).Scan(&count); e != nil || count != 0 {
		t.Fatalf("denied source mutation count=%d %v", count, e)
	}
}
