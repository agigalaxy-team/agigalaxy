package chat

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/moderation"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestModerationOriginalSignedCaseVerifierAndRevalidation(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	archive := fakeArchive(t)
	f := chatNativeFixture(t, dsn, "xmpp://"+archive.listener.Addr().String(), "moderation-server")
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
	caseSource := &cases.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock}
	evidenceSource := &evidence.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock}
	inputs := obj(f, "contacts")
	tokens := map[string]string{"owner": str(obj(f, "owner"), "token"), "peer": str(obj(f, "peer"), "token"), "handler": str(obj(inputs, "handler"), "token"), "verifier": str(obj(inputs, "verifier"), "token")}
	assistance := &taskmaterials.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, CaseOwnerSource: caseSource.RequireOwnerSourceWithin, Now: clock}
	svc := &moderation.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Cases: caseSource, Assistance: assistance, Evidence: evidenceSource, ModeratorIDs: []string{str(obj(inputs, "handler"), "subjectId")}, Now: clock}
	inbox := &notifications.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock, Readers: notifications.CurrentReaders{Moderation: svc.NotificationReadWithin}}
	server := httptest.NewServer(moderation.Handler{Service: svc, Next: notifications.Handler{Service: inbox}})
	defer server.Close()
	report := obj(inputs, "report")
	id := str(report, "id")
	readPath := "/v1/moderation/reports/" + id + "/read"
	compare := func(who string) {
		t.Helper()
		status, got := chatRequest(t, server.URL, readPath, tokens[who], Object{})
		if status != 200 {
			t.Fatal("Go moderation read", who, status, got)
		}
		status, want := chatRequest(t, str(f, "origin"), readPath, tokens[who], Object{})
		if status != 200 {
			t.Fatal("original moderation read", who, status, want)
		}
		same(t, got, want)
		if who == "owner" || who == "verifier" {
			a, e := devices.Authenticate(ctx, tokens[who], "history")
			if e != nil {
				t.Fatal(e)
			}
			tx, e := pool.Begin(ctx)
			if e != nil {
				t.Fatal(e)
			}
			currentID := strings.Split(readPath, "/")[4]
			wire, e := svc.ReadHistoryWireWithin(ctx, tx, &a, currentID)
			tx.Rollback(ctx)
			if e != nil {
				t.Fatal("actual History moderation wire", e)
			}
			status, originalWire, _ := attachmentHTTP(t, str(f, "origin"), readPath, "POST", tokens[who], encode(Object{}))
			if status != 200 || !bytes.Equal(bytes.TrimSpace(wire), bytes.TrimSpace(originalWire)) {
				t.Fatalf("original moderated History wire differs\nGo %s\nJS %s", wire, originalWire)
			}
		}
	}
	status, receipt := chatRequest(t, server.URL, "/v1/moderation/reports", tokens["owner"], inputs["grant"])
	if status != 200 {
		t.Fatal("real signed complaint", status, receipt)
	}
	status, replay := chatRequest(t, str(f, "origin"), "/v1/moderation/reports", tokens["owner"], inputs["grant"])
	if status != 200 {
		t.Fatal(replay)
	}
	same(t, receipt, replay)
	for _, who := range []string{"owner", "peer", "handler"} {
		compare(who)
	}
	status, denied := chatRequest(t, server.URL, readPath, tokens["verifier"], Object{})
	if status != 404 {
		t.Fatal("uninvited source reader acquired process role", status, denied)
	}
	status, denied = chatRequest(t, server.URL, "/v1/moderation/reports/"+id+"/events", tokens["peer"], inputs["denied"])
	if status != 403 || str(denied, "error") != "moderation_role_denied" {
		t.Fatal("case owner self adjudication", status, denied)
	}
	for _, v := range inputs["events"].([]any) {
		entry := v.(map[string]any)
		event := obj(entry, "event")
		token := tokens[str(entry, "who")]
		path := "/v1/moderation/reports/" + id + "/events"
		if event["kind"] == "revalidate" {
			status, result := chatRequest(t, server.URL, path, token, entry["grant"])
			if status != 409 || str(result, "error") != "verification_already_pending" {
				t.Fatal("pending original evidence job", status, result)
			}
			tag, e := admin.Exec(ctx, "UPDATE jobs SET state='failed' WHERE payload->>'evidenceId'=$1 AND payload->'revalidation' IS NULL", str(obj(inputs, "evidence"), "id"))
			if e != nil || tag.RowsAffected() != 1 {
				t.Fatal("simulate original worker failure only", e)
			}
		}
		status, receipt = chatRequest(t, server.URL, path, token, entry["grant"])
		if status != 200 {
			t.Fatal("real signed handling", event["kind"], status, receipt)
		}
		status, replay = chatRequest(t, str(f, "origin"), path, token, entry["grant"])
		if status != 200 {
			t.Fatal("original event replay", event["kind"], status, replay)
		}
		same(t, receipt, replay)
		for _, who := range []string{"owner", "peer", "handler", "verifier"} {
			compare(who)
		}
		q := Object{"eventId": event["id"], "payloadHash": identity.Digest([]byte(str(obj(entry, "grant"), "payloadJson")))}
		status, got := chatRequest(t, server.URL, "/v1/moderation/reports/"+id+"/receipt", token, q)
		if status != 200 {
			t.Fatal(got)
		}
		status, want := chatRequest(t, str(f, "origin"), "/v1/moderation/reports/"+id+"/receipt", token, q)
		if status != 200 {
			t.Fatal(want)
		}
		same(t, got, want)
	}
	legacy := obj(inputs, "legacy")
	legacyID := str(obj(legacy, "report"), "id")
	status, receipt = chatRequest(t, server.URL, "/v1/moderation/reports", tokens["owner"], legacy["grant"])
	if status != 200 {
		t.Fatal("real legacy Assistance report", status, receipt)
	}
	originalPath := readPath
	readPath = "/v1/moderation/reports/" + legacyID + "/read"
	for _, v := range legacy["events"].([]any) {
		entry := v.(map[string]any)
		token := tokens[str(entry, "who")]
		path := "/v1/moderation/reports/" + legacyID + "/events"
		status, receipt = chatRequest(t, server.URL, path, token, entry["grant"])
		if status != 200 {
			t.Fatal("real legacy verifier", status, receipt)
		}
		status, replay = chatRequest(t, str(f, "origin"), path, token, entry["grant"])
		if status != 200 {
			t.Fatal(replay)
		}
		same(t, receipt, replay)
		for _, who := range []string{"owner", "peer", "handler", "verifier"} {
			compare(who)
		}
	}
	readPath = originalPath
	for _, who := range []string{"owner", "verifier"} {
		status, got := chatRequest(t, server.URL, "/v2/notifications/query", tokens[who], Object{})
		if status != 200 {
			t.Fatal("moderation Inbox", status, got)
		}
		status, want := chatRequest(t, str(f, "origin"), "/v2/notifications/query", tokens[who], Object{})
		if status != 200 {
			t.Fatal(want)
		}
		same(t, got, want)
	}
	q := Object{"caseId": report["caseId"]}
	status, got := chatRequest(t, server.URL, "/v1/moderation/reports/query", tokens["verifier"], q)
	if status != 200 {
		t.Fatal(got)
	}
	status, want := chatRequest(t, str(f, "origin"), "/v1/moderation/reports/query", tokens["verifier"], q)
	if status != 200 {
		t.Fatal(want)
	}
	same(t, got, want)
	for _, who := range []string{"owner", "verifier"} {
		a, e := devices.Authenticate(ctx, tokens[who], "history")
		if e != nil {
			t.Fatal(e)
		}
		tx, e := pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		wire, e := svc.CaseContextWireWithin(ctx, tx, &a, str(obj(inputs, "root"), "id"))
		tx.Rollback(ctx)
		if e != nil {
			t.Fatal(e)
		}
		status, raw, _ := attachmentHTTP(t, str(f, "origin"), "/v1/history/query", "POST", tokens[who], encode(Object{"subjectId": obj(f, "peer")["subjectId"]}))
		var page struct {
			Items []struct {
				CaseID  string          `json:"caseId"`
				Context json.RawMessage `json:"moderationContext"`
			} `json:"items"`
		}
		if status != 200 || json.Unmarshal(raw, &page) != nil || len(page.Items) != 1 {
			t.Fatal("original History Case slot", status)
		}
		if !bytes.Equal(bytes.TrimSpace(wire), bytes.TrimSpace(page.Items[0].Context)) {
			t.Fatalf("original Case moderation context wire differs\nGo %s\nJS %s", wire, page.Items[0].Context)
		}
	}
	status, result := chatRequest(t, str(f, "origin"), "/v1/consents/"+str(obj(inputs, "caseGrant"), "consentId")+"/revoke", tokens["peer"], Object{})
	if status != 200 {
		t.Fatal("original source revoke", status, result)
	}
	for _, who := range []string{"owner", "peer", "handler", "verifier"} {
		compare(who)
	}
	var count int
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM jobs WHERE payload->>'evidenceId'=$1 AND payload->'revalidation'->>'generation'='1'", str(obj(inputs, "evidence"), "id")).Scan(&count); e != nil || count != 1 {
		t.Fatal("original job generation receipt", count, e)
	}
}
