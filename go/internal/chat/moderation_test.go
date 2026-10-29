package chat

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/moderation"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestModerationOriginalSignedCaseVerifierAndRevalidation(t *testing.T) {
	admin, dsn := testsupport.PostgreSQL(t)
	if _, err := databaseschema.Migrate(context.Background(), admin, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	f := chatGoIdentityFixture(t, admin)
	handler := deviceauthfixture.New(t, admin, t.TempDir(), []string{"binding", "consent", "history", "moderation", "notifications"})
	verifier := deviceauthfixture.New(t, admin, t.TempDir(), []string{"binding", "consent", "history", "moderation", "notifications", "case-teaser"})
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
	owner, peer := f["ownerFixture"].(deviceauthfixture.Fixture), f["peerFixture"].(deviceauthfixture.Fixture)
	tokens := map[string]string{"owner": owner.Credential, "peer": peer.Credential, "handler": handler.Credential, "verifier": verifier.Credential}
	links := &accountlinks.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Providers: []accountlinks.Provider{{Issuer: str(f, "issuer"), ClientID: "galaxy-fixture"}}, Now: clock}
	assistance := &taskmaterials.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Links: links, Writes: &publicwrites.Service{Pool: pool, Endpoint: str(f, "endpoint"), Links: links, Policy: publicwrites.DefaultPolicy(), Now: clock}, CaseOwnerSource: caseSource.RequireOwnerSourceWithin, Now: clock}
	svc := &moderation.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Cases: caseSource, Assistance: assistance, Evidence: evidenceSource, ModeratorIDs: []string{handler.Actor.SubjectID}, Now: clock}
	inbox := &notifications.Service{Pool: pool, Endpoint: str(f, "endpoint"), Devices: devices, Now: clock, Readers: notifications.CurrentReaders{Moderation: svc.NotificationReadWithin}}
	server := httptest.NewServer(moderation.Handler{Service: svc, Next: notifications.Handler{Service: inbox, Next: taskmaterials.LegacyHandler{Service: assistance}}})
	defer server.Close()
	viewers := []string{owner.Actor.SubjectID, handler.Actor.SubjectID, verifier.Actor.SubjectID}
	root := Object{"kind": "case", "id": uuid.NewString(), "localRef": uuid.NewString(), "title": "Original voluntary review", "summary": "Retained private source", "source": Object{"kind": "local", "reference": uuid.NewString()}, "participants": []any{Object{"subjectId": peer.Actor.SubjectID, "role": "requester"}, Object{"subjectId": handler.Actor.SubjectID, "role": "provider"}}}
	caseGrant := peer.Grant(t, root, "case.teaser.publish", str(root, "id"), "Private", viewers)
	if _, err := caseSource.Submit(ctx, peer.Actor, encode(caseGrant), ""); err != nil {
		t.Fatal("case source", err)
	}
	attempt := Object{"kind": "attempt", "id": uuid.NewString(), "caseId": root["id"], "expectedVersion": 1, "sequence": 1, "approach": "Controlled source", "configuration": Object{"environment": "fixture", "version": "1", "tools": []any{}}}
	if _, err := caseSource.Submit(ctx, peer.Actor, encode(peer.Grant(t, attempt, "case.teaser.publish", str(attempt, "id"), "Private", viewers)), ""); err != nil {
		t.Fatal("case attempt", err)
	}
	result := Object{"kind": "result", "id": uuid.NewString(), "caseId": root["id"], "expectedVersion": 2, "attemptId": attempt["id"], "outcome": "partial", "summary": "Reported only", "failureReason": "", "limitations": []any{"No verified capability"}}
	if _, err := caseSource.Submit(ctx, peer.Actor, encode(peer.Grant(t, result, "case.teaser.publish", str(result, "id"), "Private", viewers)), ""); err != nil {
		t.Fatal("case result", err)
	}
	proof := Object{"id": uuid.NewString(), "caseId": root["id"], "resultId": result["id"], "source": Object{"provider": "github-actions", "owner": "Fixture", "repository": "Synthetic", "runId": 11, "attempt": 1, "commit": strings.Repeat("a", 40)}}
	if _, err := evidenceSource.Submit(ctx, peer.Actor, encode(peer.Grant(t, proof, "evidence.submit", str(proof, "id"), "Private", viewers)), ""); err != nil {
		t.Fatal("evidence source", err)
	}
	report := Object{"id": uuid.NewString(), "caseId": root["id"], "caseVersion": 3, "targetEventId": result["id"], "evidenceId": proof["id"], "category": "false-verification", "summary": "Original signed private complaint"}
	target := Object{"caseId": root["id"], "caseVersion": 3, "targetEventId": result["id"], "evidenceId": proof["id"]}
	events := []any{}
	add := func(who, kind string, extra Object) Object {
		event := Object{"id": uuid.NewString(), "reportId": report["id"], "expectedVersion": len(events) + 1, "summary": "Original " + kind, "kind": kind}
		for k, v := range extra {
			event[k] = v
		}
		signer := handler
		audience := []string{owner.Actor.SubjectID, peer.Actor.SubjectID}
		if who == "verifier" {
			signer = verifier
			audience = []string{handler.Actor.SubjectID, owner.Actor.SubjectID, peer.Actor.SubjectID}
			if kind == "correct" || kind == "supplement" || kind == "appeal" {
				audience = []string{handler.Actor.SubjectID}
			}
		} else if kind == "invite-verifier" || len(events) >= 4 {
			audience = append(audience, verifier.Actor.SubjectID)
		}
		events = append(events, Object{"event": event, "who": who, "grant": signer.Grant(t, event, "moderation.publish", str(event, "id"), "Private", audience)})
		return event
	}
	first := add("handler", "invite-verifier", Object{"verifierId": verifier.Actor.SubjectID, "target": target, "scope": "Inspect only this current source", "expiresAt": num(f, "now") + 300})
	add("verifier", "decline-verifier", Object{"invitationId": first["id"]})
	second := add("handler", "invite-verifier", Object{"verifierId": verifier.Actor.SubjectID, "target": target, "scope": "Voluntary bounded review", "expiresAt": num(f, "now") + 300})
	add("verifier", "accept-verifier", Object{"invitationId": second["id"]})
	response := add("verifier", "verification-response", Object{"invitationId": second["id"], "conclusion": "inconclusive", "references": []any{Object{"kind": "case", "id": root["id"]}}})
	add("verifier", "correct", Object{"correctsEventId": response["id"], "reason": "Only a source review"})
	add("verifier", "supplement", Object{"references": []any{}})
	add("handler", "pause", nil)
	add("handler", "revalidate", Object{"evidenceId": proof["id"]})
	add("handler", "resolve", Object{"verdict": "upheld"})
	add("verifier", "appeal", nil)
	add("handler", "resume", nil)
	add("verifier", "withdraw-verifier", Object{"invitationId": second["id"]})
	add("handler", "resolve", Object{"verdict": "dismissed"})
	request := Object{"id": uuid.NewString(), "caseId": root["id"], "title": "Legacy current source", "problem": "Inspect scope", "attemptedApproaches": []any{}, "scope": "Specific review", "visibility": "Public", "collaboration": "open-assistance", "enrollmentExpiresAt": num(f, "now") + 800}
	status, got := chatRequest(t, server.URL, "/v1/assistance", peer.Credential, peer.Grant(t, request, "assistance.publish", str(request, "id"), "Public", nil))
	if status != 200 {
		t.Fatal("legacy source", status, got)
	}
	legacyReport := Object{"id": uuid.NewString(), "assistanceId": request["id"], "category": "scope", "summary": "Private assistance handling"}
	legacyEvents := []any{}
	invitation := uuid.NewString()
	legacyAdd := func(who, kind string, extra Object) {
		event := Object{"id": uuid.NewString(), "reportId": legacyReport["id"], "expectedVersion": len(legacyEvents) + 1, "summary": "Legacy " + kind, "kind": kind}
		for k, v := range extra {
			event[k] = v
		}
		signer := handler
		audience := []string{owner.Actor.SubjectID, peer.Actor.SubjectID, verifier.Actor.SubjectID}
		if who == "verifier" {
			signer = verifier
			audience = []string{owner.Actor.SubjectID, peer.Actor.SubjectID, handler.Actor.SubjectID}
		}
		legacyEvents = append(legacyEvents, Object{"event": event, "who": who, "grant": signer.Grant(t, event, "moderation.publish", str(event, "id"), "Private", audience)})
	}
	legacyAdd("handler", "invite-verifier", Object{"id": invitation, "verifierId": verifier.Actor.SubjectID, "target": Object{"assistanceId": request["id"]}, "scope": "Review current request", "expiresAt": num(f, "now") + 300})
	legacyAdd("verifier", "accept-verifier", Object{"invitationId": invitation})
	legacyAdd("verifier", "verification-response", Object{"invitationId": invitation, "conclusion": "inconclusive", "references": []any{}})
	deniedEvent := Object{"id": uuid.NewString(), "reportId": report["id"], "expectedVersion": 1, "summary": "No self adjudication", "kind": "pause"}
	inputs := Object{"root": root, "caseGrant": caseGrant, "evidence": proof, "report": report, "grant": owner.Grant(t, report, "moderation.publish", str(report, "id"), "Private", []string{handler.Actor.SubjectID}), "events": events, "legacy": Object{"report": legacyReport, "grant": owner.Grant(t, legacyReport, "moderation.publish", str(legacyReport, "id"), "Private", []string{handler.Actor.SubjectID}), "events": legacyEvents}, "denied": peer.Grant(t, deniedEvent, "moderation.publish", str(deniedEvent, "id"), "Private", []string{handler.Actor.SubjectID})}
	report = obj(inputs, "report")
	id := str(report, "id")
	readPath := "/v1/moderation/reports/" + id + "/read"
	compare := func(who string) {
		t.Helper()
		status, got := chatRequest(t, server.URL, readPath, tokens[who], Object{})
		if status != 200 {
			t.Fatal("Go moderation read", who, status, got)
		}
		if str(got, "reportId") != strings.Split(readPath, "/")[4] {
			t.Fatal("current report projection", got)
		}
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
			if !json.Valid(wire) {
				t.Fatal("invalid History moderation wire", string(wire))
			}
		}
	}
	status, receipt := chatRequest(t, server.URL, "/v1/moderation/reports", tokens["owner"], inputs["grant"])
	if status != 200 {
		t.Fatal("real signed complaint", status, receipt)
	}
	status, replay := chatRequest(t, server.URL, "/v1/moderation/reports", tokens["owner"], inputs["grant"])
	if status != 200 {
		t.Fatal(replay)
	}
	if str(receipt, "eventId") != str(replay, "eventId") {
		t.Fatal("receipt changed", receipt, replay)
	}
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
		status, replay = chatRequest(t, server.URL, path, token, entry["grant"])
		if status != 200 {
			t.Fatal("original event replay", event["kind"], status, replay)
		}
		if str(receipt, "eventId") != str(replay, "eventId") {
			t.Fatal("receipt changed", receipt, replay)
		}
		for _, who := range []string{"owner", "peer", "handler", "verifier"} {
			compare(who)
		}
		q := Object{"eventId": event["id"], "payloadHash": identity.Digest([]byte(str(obj(entry, "grant"), "payloadJson")))}
		status, got := chatRequest(t, server.URL, "/v1/moderation/reports/"+id+"/receipt", token, q)
		if status != 200 {
			t.Fatal(got)
		}
		if str(got, "eventId") != str(event, "id") {
			t.Fatal("receipt event mismatch", got)
		}
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
		status, replay = chatRequest(t, server.URL, path, token, entry["grant"])
		if status != 200 {
			t.Fatal(replay)
		}
		if str(receipt, "eventId") != str(replay, "eventId") {
			t.Fatal("receipt changed", receipt, replay)
		}
		for _, who := range []string{"owner", "peer", "handler", "verifier"} {
			compare(who)
		}
	}
	readPath = originalPath
	for _, who := range []string{"owner", "verifier"} {
		status, got := chatRequest(t, server.URL, "/v2/notifications/query", tokens[who], Object{})
		if status != 200 || got["items"] == nil {
			t.Fatal("moderation inbox", status, got)
		}
		a, e := devices.Authenticate(ctx, tokens[who], "history")
		if e != nil {
			t.Fatal(e)
		}
		tx, e := pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		wire, e := svc.CaseContextWireWithin(ctx, tx, &a, str(root, "id"))
		tx.Rollback(ctx)
		if e != nil || !json.Valid(wire) {
			t.Fatal("case moderation context", e)
		}
	}
	status, got = chatRequest(t, server.URL, "/v1/moderation/reports/query", tokens["verifier"], Object{"caseId": report["caseId"]})
	if status != 200 || got["items"] == nil {
		t.Fatal("moderation query", status, got)
	}
	if _, e = devices.RevokeConsent(ctx, peer.Actor, str(obj(inputs, "caseGrant"), "consentId"), nil); e != nil {
		t.Fatal("source revoke", e)
	}
	for _, who := range []string{"owner", "peer", "handler", "verifier"} {
		compare(who)
	}
	var count int
	if e = admin.QueryRow(ctx, "SELECT count(*) FROM jobs WHERE payload->>'evidenceId'=$1 AND payload->'revalidation'->>'generation'='1'", str(obj(inputs, "evidence"), "id")).Scan(&count); e != nil || count != 1 {
		t.Fatal("original job generation receipt", count, e)
	}
}
