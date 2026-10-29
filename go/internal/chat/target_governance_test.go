package chat

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/targetgovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTargetGovernanceOriginalSignedTaskRoomAndCurrentRestrictions(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	if _, err := databaseschema.Migrate(context.Background(), admin, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	archive := fakeArchive(t)
	url := "xmpp://" + archive.Listener.Addr().String()
	f := chatGoIdentityFixture(t, admin)
	handlerFixture := deviceauthfixture.New(t, admin, t.TempDir(), []string{"binding", "consent", "history", "notifications", "moderation"})
	ctx := context.Background()
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	clock := func() time.Time { return time.Unix(num(f, "now"), 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: str(f, "endpoint"), Now: clock}
	ownerToken := str(obj(f, "owner"), "token")
	owner, e := devices.Authenticate(ctx, ownerToken, "moderation")
	if e != nil {
		t.Fatal(e)
	}
	ownerFixture := f["ownerFixture"].(deviceauthfixture.Fixture)
	peerFixture := f["peerFixture"].(deviceauthfixture.Fixture)
	handlerToken := handlerFixture.Credential
	links := &accountlinks.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: clock}
	transport, e := NewComponentTransport(url, "gateway.example.invalid", "rooms.example.invalid", testSecret, time.Second)
	if e != nil {
		t.Fatal(e)
	}
	if e = transport.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer transport.Stop()
	chat := &Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: links, Transport: transport, Rules: &businessrules.Service{Endpoint: str(f, "endpoint"), Now: clock}, Now: clock}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: links, Writes: &publicwrites.Service{Pool: pool, Endpoint: str(f, "endpoint"), Links: links, Policy: publicwrites.DefaultPolicy(), Now: clock}, Now: clock}
	svc := &targetgovernance.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: links, Tasks: tasks, Chat: chat, ModeratorIDs: []string{handlerFixture.Actor.SubjectID}, Now: clock}
	inbox := &notifications.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock, Readers: notifications.CurrentReaders{Task: tasks.NotificationReadWithin, TargetGovernance: svc.NotificationReadWithin, Chat: func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, c Object) (Object, error) {
		return chat.NotificationViewWithin(ctx, tx, a, str(c, "kind"), str(c, "event_id"), str(c, "room_id"))
	}}}
	server := httptest.NewServer(targetgovernance.Handler{Service: svc, Next: notifications.Handler{Service: inbox, Next: taskmaterials.Handler{Task: tasks}}})
	defer server.Close()
	task := Object{"operationId": uuid.NewString(), "taskId": uuid.NewString(), "caseId": nil, "intent": "proactive-review", "title": "Target current source", "summary": "Separate current grant", "workContext": Object{"goal": "Review", "currentSituation": "Current source", "attemptRefs": []any{}}, "visibility": "Public", "collaboration": "open-assistance", "enrollmentExpiresAt": num(f, "now") + 3600}
	status, result := chatRequest(t, server.URL, "/v2/tasks", peerFixture.Credential, peerFixture.Grant(t, task, "assistance.publish", str(task, "operationId"), "Public", nil))
	if status != 200 {
		t.Fatal("real task source", status, result)
	}
	roomID := uuid.NewString()
	if _, e = chat.Create(ctx, Actor{Device: &owner}, encode(Object{"roomId": roomID, "operationId": uuid.NewString(), "title": "Ordinary governance source"})); e != nil {
		t.Fatal("real room source", e)
	}
	inputs := Object{}
	for _, item := range []struct{ kind, id string }{{"task", str(task, "taskId")}, {"room", roomID}} {
		info, err := svc.TargetInfo(ctx, targetgovernance.Actor{Device: &owner}, encode(Object{"type": item.kind, "id": item.id}))
		if err != nil {
			t.Fatal("target info", item.kind, err)
		}
		target := obj(info, "target")
		report := Object{"schemaVersion": 2, "id": uuid.NewString(), "target": target, "category": "other", "summary": "Private original report"}
		events := []any{}
		add := func(who, kind string, extra Object) {
			event := Object{"schemaVersion": 2, "id": uuid.NewString(), "reportId": report["id"], "expectedVersion": len(events) + 1, "kind": kind, "summary": "Original " + kind}
			for k, v := range extra {
				event[k] = v
			}
			signer, audience := handlerFixture, []string{owner.SubjectID}
			if who == "owner" {
				signer, audience = ownerFixture, []string{handlerFixture.Actor.SubjectID}
			}
			events = append(events, Object{"event": event, "who": who, "grant": signer.Grant(t, event, "moderation.publish", str(event, "id"), "Private", audience)})
		}
		if item.kind == "task" {
			add("handler", "review", nil)
			add("handler", "pause", Object{"targetVersion": target["version"], "scopes": []string{"discovery-hidden", "new-participation-paused"}, "until": num(f, "now") + 1000, "rule": "fixture"})
			add("owner", "appeal", nil)
			add("handler", "resume", nil)
			add("handler", "resolve", Object{"targetVersion": target["version"], "verdict": "dismissed", "rule": "fixture", "restriction": nil})
			add("owner", "appeal", nil)
			add("owner", "supplement", nil)
			add("owner", "withdraw-report", nil)
			add("handler", "resume", nil)
		} else {
			add("handler", "pause", Object{"targetVersion": target["version"], "scopes": []string{"sending-paused", "invitations-paused"}, "until": num(f, "now") + 1000, "rule": "fixture"})
			add("handler", "resume", nil)
		}
		inputs[item.kind] = Object{"report": report, "grant": ownerFixture.Grant(t, report, "moderation.publish", str(report, "id"), "Private", []string{handlerFixture.Actor.SubjectID}), "events": events}
	}
	compare := func(path, token string) {
		t.Helper()
		status, got := targetGet(t, server.URL, path, token)
		if status != 200 {
			t.Fatal("Go source", status, got)
		}
		if got["reportId"] == nil || got["currentTarget"] == nil {
			t.Fatal("missing target report", got)
		}
	}
	for _, kind := range []string{"task", "room"} {
		input := obj(inputs, kind)
		report := obj(input, "report")
		status, receipt := chatRequest(t, server.URL, "/v2/target-governance/reports", ownerToken, input["grant"])
		if status != 200 {
			t.Fatal("actual signed report", kind, status, receipt)
		}
		status, replayed := chatRequest(t, server.URL, "/v2/target-governance/reports", ownerToken, input["grant"])
		if status != 200 {
			t.Fatal(replayed)
		}
		if str(replayed, "state") != "acknowledged" {
			t.Fatal("report replay", replayed)
		}
		compare("/v2/target-governance/"+str(report, "id"), ownerToken)
		compare("/v2/target-governance/"+str(report, "id"), handlerToken)
		for _, v := range input["events"].([]any) {
			entry := v.(map[string]any)
			event := obj(entry, "event")
			token := handlerToken
			if entry["who"] == "owner" {
				token = ownerToken
			}
			status, receipt = chatRequest(t, server.URL, "/v2/target-governance/events", token, entry["grant"])
			if status != 200 {
				t.Fatal("actual signed decision", kind, event["kind"], status, receipt)
			}
			status, replayed = chatRequest(t, server.URL, "/v2/target-governance/events", token, entry["grant"])
			if status != 200 {
				t.Fatal("original replay", event["kind"], status, replayed)
			}
			if str(replayed, "state") != "acknowledged" {
				t.Fatal("event replay", replayed)
			}
			compare("/v2/target-governance/"+str(report, "id"), ownerToken)
			compare("/v2/target-governance/"+str(report, "id"), handlerToken)
			if event["kind"] == "pause" {
				if kind == "room" {
					_, e = chat.Send(ctx, Actor{Device: &owner}, str(obj(report, "target"), "id"), encode(Object{"clientMessageId": uuid.NewString(), "text": "Must not reach retained transport"}))
					if fault.Code(e) != "target_operation_restricted" {
						t.Fatal("real room source sending gate", e)
					}
				} else {
					tx, e := pool.Begin(ctx)
					if e != nil {
						t.Fatal(e)
					}
					_, e = tasks.RequireTaskWithin(ctx, tx, nil, str(obj(report, "target"), "id"), false)
					tx.Rollback(ctx)
					if fault.Status(e) != 404 {
						t.Fatal("real public Task discovery gate", e)
					}
				}
			}
			hash := identity.Digest([]byte(str(obj(entry, "grant"), "payloadJson")))
			q := Object{"eventId": event["id"], "payloadHash": hash}
			status, got := chatRequest(t, server.URL, "/v2/target-governance/receipt", token, q)
			if status != 200 {
				t.Fatal(got)
			}
			if got["state"] == nil {
				t.Fatal("missing target receipt", got)
			}
		}
		q := Object{"target": Object{"type": kind, "id": obj(report, "target")["id"]}}
		status, got := chatRequest(t, server.URL, "/v2/target-governance/query", ownerToken, q)
		if status != 200 {
			t.Fatal(got)
		}
		if got["items"] == nil {
			t.Fatal("missing target query items", got)
		}
	}
	var audits int
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE action LIKE 'target.moderation.%'").Scan(&audits); e != nil || audits != 13 {
		t.Fatal("actual current author audit", audits, e)
	}
	status, goInbox := chatRequest(t, server.URL, "/v2/notifications/query", ownerToken, Object{})
	if status != 200 {
		t.Fatal("actual target Inbox", status, goInbox)
	}
	if goInbox["items"] == nil {
		t.Fatal("missing notifications", goInbox)
	}
	workerCfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	workerCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, e := pgxpool.NewWithConfig(ctx, workerCfg)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	tx, e := worker.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	purged, e := svc.CleanupRetentionWithin(ctx, tx, num(f, "now")+181*86400)
	if e != nil {
		tx.Rollback(ctx)
		t.Fatal("worker original retention", e)
	}
	if num(purged, "targetReports") != 1 || num(purged, "targetGovernanceEvents") != 10 {
		t.Fatal("bounded closed-case retention", purged)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
}
func targetGet(t *testing.T, origin, path, token string) (int, Object) {
	t.Helper()
	status, raw, _ := attachmentHTTP(t, origin, path, "GET", token, nil)
	var out Object
	if e := json.Unmarshal(raw, &out); e != nil {
		t.Fatal(e)
	}
	return status, out
}
