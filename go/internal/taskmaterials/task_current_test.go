package taskmaterials

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/accountlinkfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCurrentTaskAndParticipationTransitions(t *testing.T) {
	ownerPool, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, ownerPool, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	endpoint := devicefixture.Endpoint
	scopes := []string{"binding", "consent", "assistance", "history", "notifications", "case-teaser", "moderation"}
	owner := deviceauthfixture.New(t, ownerPool, t.TempDir(), scopes)
	author := deviceauthfixture.New(t, ownerPool, t.TempDir(), scopes)
	moderator := deviceauthfixture.New(t, ownerPool, t.TempDir(), scopes)
	account := accountlinkfixture.New(t, ownerPool, owner.Service)
	account.Link(owner, "task-owner")
	cfg := ownerPool.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(devicefixture.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: endpoint, Now: now}
	links := account.Registry
	links.Pool = pool
	links.Devices = devices
	writes := &publicwrites.Service{Pool: pool, Endpoint: endpoint, Links: links, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now}
	svc := &Service{Pool: pool, Endpoint: endpoint, Devices: devices, Writes: writes, Links: links, Now: now, CaseOwnerSource: cs.RequireOwnerSourceWithin}
	svc.CaseWithin, svc.OwnedCaseLive = cs.CaseWithin, cs.RequireOwnedCaseLiveWithin
	cs.TaskRead = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
		return svc.RequireTaskWithin(ctx, tx, &a, id, false)
	}
	cs.TaskWrite = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
		return svc.RequireTaskWithin(ctx, tx, &a, id, true)
	}
	cs.Participation = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, task, id string) (Object, error) {
		return svc.RequireParticipationWithin(ctx, tx, a, task, id, false)
	}
	cs.AttachCase = svc.AttachCaseWithin
	inbox := &notifications.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now}
	comments := &CommentService{Service: svc}
	governance := &CommentGovernance{CommentService: comments, ModeratorIDs: []string{moderator.Actor.SubjectID}}
	inbox.Readers = notifications.CurrentReaders{Task: svc.NotificationReadWithin, Assistance: svc.LegacyNotificationReadWithin, Comment: comments.NotificationReadWithin, CommentGovernance: governance.NotificationReadWithin}
	h := notifications.Handler{Service: inbox, Next: CommentGovernanceHandler{Service: governance, Next: CommentHandler{Service: comments, Next: Handler{Task: svc, Next: cases.Handler{Service: cs, Devices: devices}}}}}
	call := func(path string, input any, who deviceauthfixture.Fixture, status int) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+who.Credential)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s status %d expected %d: %s", path, w.Code, status, w.Body.String())
		}
		var result Object
		if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
			t.Fatal(e)
		}
		return result
	}
	tid, op := uuid.NewString(), uuid.NewString()
	task := Object{"operationId": op, "taskId": tid, "caseId": nil, "intent": "collaboration", "title": "Exact selected Task", "summary": "Explicit collaboration", "workContext": Object{"goal": "Original goal", "currentSituation": "Original situation", "attemptRefs": []any{}}, "visibility": "Private", "collaboration": "open-assistance", "capabilityId": "code", "enrollmentExpiresAt": devicefixture.Now + 3600}
	create := owner.Grant(t, task, "assistance.publish", op, "Private", []string{author.Actor.SubjectID, moderator.Actor.SubjectID})
	made := call("/v2/tasks", create, owner, 200)
	replay := call("/v2/tasks", create, owner, 200)
	if made["taskId"] != tid || made["eventId"] != replay["eventId"] {
		t.Fatal("task create ACK changed", made, replay)
	}
	caseID := uuid.NewString()
	root := Object{"schemaVersion": 2, "kind": "case-created", "eventId": caseID, "caseId": caseID, "expectedVersion": 0, "actorId": owner.Actor.SubjectID, "taskId": tid, "localRef": "task-" + caseID, "title": "这次求助的工作记录", "summary": "任务协作记录，仅保存各参与者报告的实际工作。", "source": Object{"kind": "active-task", "reference": tid}, "synthetic": true}
	initialID := uuid.NewString()
	initial := Object{"schemaVersion": 2, "kind": "attempt-start", "eventId": initialID, "caseId": caseID, "expectedVersion": 1, "actorId": owner.Actor.SubjectID, "taskId": tid, "role": "requester", "strategy": "Selected local work", "inputScopeSummary": "Controlled material scope", "permissionScope": []any{"selected-context"}}
	link := Object{"operationId": uuid.NewString(), "expectedTaskVersion": 1, "case": owner.Grant(t, root, "case.teaser.publish", caseID, "Private", nil), "initialFact": owner.Grant(t, initial, "case.teaser.publish", initialID, "Private", nil)}
	linked := call("/v2/tasks/"+tid+"/case", link, owner, 200)
	againLink := call("/v2/tasks/"+tid+"/case", link, owner, 200)
	if canonical(linked) != canonical(againLink) || num(linked["caseVersion"]) != 2 || num(linked["taskVersion"]) != 1 || num(linked["failedAttemptsCreated"]) != 0 {
		t.Fatal("case link replay changed", linked, againLink)
	}
	// Quota writes roll back with their caller and remain idempotent.
	publicActor := publicwrites.Actor{Device: &owner.Actor, Scope: "assistance"}
	quotaBefore, e := writes.Status(ctx, publicwrites.Actor{Device: &owner.Actor, Scope: "binding"})
	if e != nil {
		t.Fatal(e)
	}
	quotaOp := publicwrites.Operation{Kind: "comment", OperationID: uuid.NewString(), PayloadHash: strings.Repeat("c", 64), TaskID: tid}
	rollback := errors.New("owning transaction failed")
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		if _, err := writes.ConsumeWithin(ctx, tx, publicActor, quotaOp); err != nil {
			return nil, err
		}
		return nil, rollback
	})
	if !errors.Is(e, rollback) {
		t.Fatal(e)
	}
	quotaAfter, e := writes.Status(ctx, publicwrites.Actor{Device: &owner.Actor, Scope: "binding"})
	if e != nil || canonical(quotaBefore) != canonical(quotaAfter) {
		t.Fatal("quota rollback changed state", e)
	}
	consume := func(op publicwrites.Operation) (Object, error) {
		return postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return writes.ConsumeWithin(ctx, tx, publicActor, op) })
	}
	first, e := consume(quotaOp)
	if e != nil {
		t.Fatal(e)
	}
	second, e := consume(quotaOp)
	if e != nil || first["operationId"] != second["operationId"] {
		t.Fatal("quota replay", first, second, e)
	}
	conflict := quotaOp
	conflict.PayloadHash = strings.Repeat("d", 64)
	if _, e = consume(conflict); fault.Code(e) != "public_write_conflict" {
		t.Fatal("quota conflict lost", e)
	}
	invitationQuota := publicwrites.Operation{Kind: "invitation", OperationID: uuid.NewString(), PayloadHash: strings.Repeat("e", 64), TaskID: tid, RecipientID: author.Actor.SubjectID}
	if _, e = consume(invitationQuota); e != nil {
		t.Fatal(e)
	}
	invitationQuota.OperationID = uuid.NewString()
	if _, e = consume(invitationQuota); fault.Code(e) != "invitation_cooldown" || publicwrites.Details(e)["retryAfterSeconds"] == nil {
		t.Fatal("invitation cooldown", e)
	}
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		return true, writes.MarkInvitationRespondedWithin(ctx, tx, publicwrites.Targets{TaskID: tid, RecipientID: author.Actor.SubjectID})
	}); e != nil {
		t.Fatal(e)
	}
	sendTask := func(who deviceauthfixture.Fixture, event Object, viewers []string) Object {
		t.Helper()
		payload := Object{"taskId": tid, "event": event}
		input := who.Grant(t, payload, "assistance.publish", str(event, "eventId"), "Private", viewers)
		path := "/v2/tasks/" + tid + "/events"
		accepted := call(path, input, who, 200)
		again := call(path, input, who, 200)
		if accepted["eventId"] != again["eventId"] || num(accepted["version"]) != num(again["version"]) {
			t.Fatal("task event ACK changed", accepted, again)
		}
		return accepted
	}
	invitation := uuid.NewString()
	sendTask(owner, Object{"eventId": invitation, "expectedTaskVersion": 1, "kind": "invite", "recipientId": author.Actor.SubjectID, "note": "Explicit invitation", "expiresAt": devicefixture.Now + 300}, []string{author.Actor.SubjectID})
	sendTask(author, Object{"eventId": uuid.NewString(), "expectedTaskVersion": 2, "kind": "invitation-reply", "invitationId": invitation, "response": "interested", "message": "Interested on stated scope"}, []string{owner.Actor.SubjectID})
	application := uuid.NewString()
	sendTask(author, Object{"eventId": application, "expectedTaskVersion": 3, "kind": "apply", "proposal": "Concrete application", "scope": "Selected context only"}, []string{owner.Actor.SubjectID})
	sendTask(owner, Object{"eventId": uuid.NewString(), "expectedTaskVersion": 4, "kind": "suggest-contacts", "state": "empty", "items": []any{}}, nil)
	pid := uuid.NewString()
	proposal := Object{"eventId": uuid.NewString(), "expectedTaskVersion": 5, "kind": "propose", "participationId": pid, "subjectId": author.Actor.SubjectID, "role": "contribution", "scopeVersion": 1, "agreedScope": "Explicit selected scope", "applicationId": application}
	sendPart := func(who deviceauthfixture.Fixture, event Object, propose bool) Object {
		t.Helper()
		other := owner.Actor.SubjectID
		if who.Actor.SubjectID == owner.Actor.SubjectID {
			other = author.Actor.SubjectID
		}
		input := who.Grant(t, event, "assistance.publish", str(event, "eventId"), "Private", []string{other})
		path := "/v2/participations/" + pid + "/events"
		if propose {
			path = "/v2/tasks/" + tid + "/participations"
		}
		accepted := call(path, input, who, 200)
		again := call(path, input, who, 200)
		if accepted["eventId"] != again["eventId"] || num(accepted["version"]) != num(again["version"]) {
			t.Fatal("participation ACK changed", accepted, again)
		}
		return accepted
	}
	sendPart(owner, proposal, true)
	sendPart(author, Object{"eventId": uuid.NewString(), "expectedParticipationVersion": 1, "kind": "confirm", "scopeVersion": 1}, false)
	scope1 := uuid.NewString()
	sendPart(owner, Object{"eventId": scope1, "expectedParticipationVersion": 2, "kind": "propose-scope", "scopeVersion": 2, "agreedScope": "Proposed scope", "reason": "Clarify scope"}, false)
	sendPart(author, Object{"eventId": uuid.NewString(), "expectedParticipationVersion": 3, "kind": "decline-scope", "proposalId": scope1, "reason": "Retain scope"}, false)
	scope2 := uuid.NewString()
	sendPart(owner, Object{"eventId": scope2, "expectedParticipationVersion": 4, "kind": "propose-scope", "scopeVersion": 2, "agreedScope": "Mutual revised scope", "reason": "Revised scope"}, false)
	sendPart(author, Object{"eventId": uuid.NewString(), "expectedParticipationVersion": 5, "kind": "confirm-scope", "proposalId": scope2}, false)
	// The selected result is a real signed Case event; delivery remains denied
	// until the service installs the source-validation adapter.
	common := Object{"schemaVersion": 2, "caseId": caseID, "actorId": author.Actor.SubjectID, "taskId": tid, "participationId": pid, "taskScopeVersion": 1, "participationScopeVersion": 2}
	attempt := clone(common)
	attemptID := uuid.NewString()
	for k, v := range (Object{"kind": "attempt-start", "eventId": attemptID, "expectedVersion": 2, "role": "contribution", "strategy": "Actual participant work", "inputScopeSummary": "Explicit selected source", "permissionScope": []any{"selected-context"}}) {
		attempt[k] = v
	}
	attemptGrant := author.Grant(t, attempt, "case.teaser.publish", attemptID, "Private", []string{owner.Actor.SubjectID})
	raw, _ := json.Marshal(attemptGrant)
	started, e := cs.SubmitV2(ctx, author.Actor, raw, "")
	if e != nil {
		t.Fatal(e)
	}
	fact := clone(common)
	factID := uuid.NewString()
	for k, v := range (Object{"kind": "result-recorded", "eventId": factID, "expectedVersion": 3, "origin": Object{"kind": "attempt", "id": obj(started, "objectRef")["id"], "version": obj(started, "objectRef")["version"]}, "scopeVersion": 1, "deliverableRefs": []any{}, "reportedOutcome": "partial", "summary": "Participant-reported result", "limitations": "Explicit fixture only"}) {
		fact[k] = v
	}
	factGrant := author.Grant(t, fact, "case.teaser.publish", factID, "Private", []string{owner.Actor.SubjectID})
	raw, _ = json.Marshal(factGrant)
	recorded, e := cs.SubmitV2(ctx, author.Actor, raw, "")
	if e != nil {
		t.Fatal(e)
	}
	deliveryID := uuid.NewString()
	delivery := Object{"eventId": deliveryID, "expectedParticipationVersion": 6, "kind": "deliver", "resultRef": recorded["objectRef"], "interventionRefs": []any{}, "evidenceRefs": []any{}, "summary": "Submit selected result"}
	deliveryGrant := author.Grant(t, delivery, "assistance.publish", deliveryID, "Private", []string{owner.Actor.SubjectID})
	call("/v2/participations/"+pid+"/events", deliveryGrant, author, 503)
	svc.ValidateDelivery = func(ctx context.Context, tx pgx.Tx, a Actor, in DeliveryInput) error {
		_, err := cs.ValidateDeliveryWithin(ctx, tx, a.Actor, cases.DeliveryInput{TaskID: in.TaskID, CaseID: in.CaseID, ParticipationID: in.ParticipationID, SubjectID: in.SubjectID, ScopeVersion: &in.ScopeVersion, ResultRef: in.ResultRef, InterventionRefs: in.InterventionRefs, EvidenceRefs: in.EvidenceRefs})
		return err
	}
	acceptedDelivery := call("/v2/participations/"+pid+"/events", deliveryGrant, author, 200)
	replayedDelivery := call("/v2/participations/"+pid+"/events", deliveryGrant, author, 200)
	if acceptedDelivery["eventId"] != replayedDelivery["eventId"] {
		t.Fatal("delivery acknowledgment changed")
	}
	sendPart(owner, Object{"eventId": uuid.NewString(), "expectedParticipationVersion": 7, "kind": "accept", "deliveryId": deliveryID, "summary": "Accept reported result"}, false)
	sendPart(owner, Object{"eventId": uuid.NewString(), "expectedParticipationVersion": 8, "kind": "dispute", "reason": "Record scope dispute"}, false)
	resolution := uuid.NewString()
	sendPart(owner, Object{"eventId": resolution, "expectedParticipationVersion": 9, "kind": "propose-resolution", "outcome": "resume-work", "summary": "Resume stated work"}, false)
	sendPart(author, Object{"eventId": uuid.NewString(), "expectedParticipationVersion": 10, "kind": "confirm-resolution", "proposalId": resolution}, false)
	sendPart(author, Object{"eventId": uuid.NewString(), "expectedParticipationVersion": 11, "kind": "withdraw", "reason": "Stop own participation"}, false)
	sendPart(author, Object{"eventId": uuid.NewString(), "expectedParticipationVersion": 12, "kind": "requester-feedback", "descriptionClarity": "partly-clear", "scopeMatched": true, "note": "Participant report"}, false)
	sendTask(owner, Object{"eventId": uuid.NewString(), "expectedTaskVersion": 18, "kind": "stop-enrollment", "reason": "Stop new applications"}, nil)
	sendTask(owner, Object{"eventId": uuid.NewString(), "expectedTaskVersion": 19, "kind": "close", "reason": "Explicit termination", "terminationIntent": "terminate-task"}, nil)
	var participation, taskState Object
	if e = ownerPool.QueryRow(ctx, "SELECT snapshot FROM task_participations WHERE id=$1", pid).Scan(&participation); e != nil {
		t.Fatal(e)
	}
	if str(participation, "state") != "withdrawn" || num(participation["scopeVersion"]) != 2 || str(participation, "agreedScope") != "Mutual revised scope" || obj(participation, "feedback")["authority"] != "provider-reported" || obj(participation, "feedback")["independentQualityRating"] != false || participation["contextAccessGranted"] != false || participation["roomMembershipGranted"] != false || participation["paymentExecuted"] != false {
		t.Fatal("participation state or authority widened", participation)
	}
	if e = ownerPool.QueryRow(ctx, "SELECT snapshot FROM task_requests WHERE id=$1", tid).Scan(&taskState); e != nil || str(taskState, "state") != "closed" {
		t.Fatal("task not closed", taskState, e)
	}
	// Database defaults use wall time; align only this synthetic fixture with
	// its fixed 2033 service clock so Inbox retention can see the events.
	if _, e = ownerPool.Exec(ctx, "UPDATE task_events SET created_at=to_timestamp($2) WHERE task_id=$1", tid, devicefixture.Now); e != nil {
		t.Fatal(e)
	}
	query := call("/v2/notifications/query", Object{}, owner, 200)
	var claim Object
	for _, value := range arr(query["items"]) {
		notice, _ := value.(map[string]any)
		if truth(notice["interruptiveEligible"]) && strings.HasPrefix(str(notice, "id"), "task-v2:") {
			claim = Object{"id": notice["id"], "deliveryClientId": uuid.NewString(), "claimId": uuid.NewString()}
			break
		}
	}
	if claim == nil {
		t.Fatal("current Task notice missing", query)
	}
	claimed := call("/v2/notifications/presentation/claim", claim, owner, 200)
	claimAgain := call("/v2/notifications/presentation/claim", claim, owner, 200)
	if canonical(claimed) != canonical(claimAgain) {
		t.Fatal("claim replay changed", claimed, claimAgain)
	}
	other := clone(claim)
	other["deliveryClientId"], other["claimId"] = uuid.NewString(), uuid.NewString()
	if truth(call("/v2/notifications/presentation/claim", other, owner, 200)["claimed"]) {
		t.Fatal("two clients claimed one presentation")
	}
	shown := call("/v2/notifications/presentation/ack", claim, owner, 200)
	if truth(shown["read"]) || truth(shown["humanReadChanged"]) {
		t.Fatal("display forged human read", shown)
	}
	call("/v2/notifications/read", Object{"id": claim["id"], "reader": "assistant"}, owner, 400)
	read := call("/v2/notifications/read", Object{"id": claim["id"], "reader": "human"}, owner, 200)
	if !truth(read["read"]) {
		t.Fatal("human read was not recorded", read)
	}
	wireRead := func() []byte {
		t.Helper()
		wire, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (json.RawMessage, error) { return svc.ReadHistoryWireWithin(ctx, tx, &owner.Actor, tid) })
		if err != nil {
			t.Fatal(err)
		}
		return wire
	}
	wire := wireRead()
	prefix := `{"requesterId":"` + owner.Actor.SubjectID + `","caseId":"` + caseID + `","request":{"title":"Exact selected Task","summary":"Explicit collaboration","capabilityId":"code"},"participations":[`
	if !bytes.HasPrefix(wire, []byte(prefix)) || !bytes.Contains(wire, []byte("Mutual revised scope")) {
		t.Fatalf("history wire order or source content changed: %s", wire)
	}
	queryWire, e := svc.QueryTasksWire(ctx, &Actor{Actor: owner.Actor}, "requested", "", "", 12)
	if e != nil || !bytes.HasPrefix(queryWire, []byte(`{"items":[`)) || !bytes.Contains(queryWire, []byte(tid)) {
		t.Fatal("current task query wire", e)
	}
	var scopeConsent string
	if e = ownerPool.QueryRow(ctx, "SELECT consent_id::text FROM task_events WHERE id=$1", scope2).Scan(&scopeConsent); e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Service.RevokeConsent(ctx, owner.Actor, scopeConsent, nil); e != nil {
		t.Fatal(e)
	}
	wire = wireRead()
	if bytes.Contains(wire, []byte("Mutual revised scope")) || !bytes.Contains(wire, []byte(`"scopeAvailable":false`)) {
		t.Fatal("history leaked withdrawn scope", string(wire))
	}
	prefs := call("/v1/notifications/preferences/read", Object{}, owner, 200)
	settings := clone(obj(prefs, "settings"))
	settings["discovery"] = Object{"enabled": true, "purposes": []string{"conversation"}, "functions": []string{}, "temporary": nil}
	saved := call("/v1/notifications/preferences/save", Object{"expectedRevision": prefs["revision"], "settings": settings}, owner, 200)
	oldSettings := clone(obj(saved, "settings"))
	delete(oldSettings, "discovery")
	retained := call("/v1/notifications/preferences/save", Object{"expectedRevision": saved["revision"], "settings": oldSettings}, owner, 200)
	if !truth(obj(obj(retained, "settings"), "discovery")["enabled"]) {
		t.Fatal("old client erased discovery preference", retained)
	}
	archiveInput := Object{"expectedRevision": retained["revision"], "before": devicefixture.Now}
	archived := call("/v1/notifications/archive", archiveInput, owner, 200)
	call("/v1/notifications/archive", Object{"expectedRevision": archived["revision"], "before": devicefixture.Now - 1}, owner, 409)
	options := call("/v2/notifications/options/read", Object{}, owner, 200)
	newOptions := clone(obj(options, "settings"))
	newOptions["tasks"] = false
	muted := call("/v2/notifications/options/save", Object{"expectedRevision": options["revision"], "settings": newOptions}, owner, 200)
	if truth(obj(muted, "settings")["tasks"]) {
		t.Fatal("task interruption mute lost", muted)
	}
	// The still-supported v1 assistance route retains its original signed
	// event sequence, current role projection, and exact event receipts.
	legacyCase := uuid.NewString()
	legacyRoot := Object{"kind": "case", "id": legacyCase, "localRef": "legacy-" + legacyCase, "title": "Original v1 Case source", "summary": "Explicit isolated source", "source": Object{"kind": "local", "reference": "legacy-" + legacyCase}, "participants": []any{Object{"subjectId": owner.Actor.SubjectID, "role": "requester"}, Object{"subjectId": author.Actor.SubjectID, "role": "provider"}}}
	caseGrant := owner.Grant(t, legacyRoot, "case.teaser.publish", legacyCase, "Private", []string{author.Actor.SubjectID})
	raw, _ = json.Marshal(caseGrant)
	if _, e = cs.Submit(ctx, owner.Actor, raw, ""); e != nil {
		t.Fatal(e)
	}
	attemptLegacy := uuid.NewString()
	legacyAttempt := Object{"kind": "attempt", "id": attemptLegacy, "caseId": legacyCase, "expectedVersion": 1, "sequence": 1, "approach": "Explicit local attempt report", "configuration": Object{"environment": "isolated", "version": "1", "tools": []any{}}}
	caseGrant = owner.Grant(t, legacyAttempt, "case.teaser.publish", attemptLegacy, "Private", []string{author.Actor.SubjectID})
	raw, _ = json.Marshal(caseGrant)
	if _, e = cs.Submit(ctx, owner.Actor, raw, ""); e != nil {
		t.Fatal(e)
	}
	legacyID := uuid.NewString()
	legacyRequest := Object{"id": legacyID, "caseId": legacyCase, "title": "Original v1 assistance", "problem": "Participant-reported work", "attemptedApproaches": []any{"Original recorded attempt"}, "scope": "Explicit collaboration scope", "visibility": "Private", "collaboration": "open-assistance", "capabilityId": "code", "enrollmentExpiresAt": devicefixture.Now + 3600}
	legacyGrant := owner.Grant(t, legacyRequest, "assistance.publish", legacyID, "Private", []string{author.Actor.SubjectID})
	createdLegacy := call("/v1/assistance", legacyGrant, owner, 200)
	if canonical(createdLegacy) != canonical(call("/v1/assistance", legacyGrant, owner, 200)) {
		t.Fatal("legacy create ACK changed")
	}
	version := 1
	emitLegacy := func(who deviceauthfixture.Fixture, event Object) {
		t.Helper()
		if event["id"] == nil {
			event["id"] = uuid.NewString()
		}
		event["expectedVersion"] = version
		version++
		viewer := owner.Actor.SubjectID
		if who.Actor.SubjectID == viewer {
			viewer = author.Actor.SubjectID
		}
		payload := Object{"assistanceId": legacyID, "event": event}
		grant := who.Grant(t, payload, "assistance.publish", str(event, "id"), "Private", []string{viewer})
		path := "/v1/assistance/" + legacyID + "/events"
		accepted := call(path, grant, who, 200)
		replayed := call(path, grant, who, 200)
		if canonical(accepted) != canonical(replayed) {
			t.Fatal("legacy event ACK changed", accepted, replayed)
		}
		receipt := call("/v1/assistance/events/receipt", Object{"assistanceId": legacyID, "eventId": event["id"], "payloadHash": identity.Digest([]byte(grant["payloadJson"].(string)))}, who, 200)
		if receipt["state"] != "acknowledged" {
			t.Fatal("legacy event receipt", receipt)
		}
	}
	emitLegacy(owner, Object{"kind": "invite", "participantId": author.Actor.SubjectID, "note": "Explicit invitation"})
	offer1, offer2 := uuid.NewString(), uuid.NewString()
	emitLegacy(author, Object{"kind": "offer", "id": offer1, "proposal": "First proposal", "scope": "Initial scope"})
	emitLegacy(owner, Object{"kind": "shortlist", "offerIds": []any{offer1}})
	emitLegacy(author, Object{"kind": "withdraw-offer", "offerId": offer1, "reason": "Withdraw first proposal"})
	emitLegacy(author, Object{"kind": "offer", "id": offer2, "proposal": "Revised proposal", "scope": "Selected scope"})
	emitLegacy(owner, Object{"kind": "shortlist", "offerIds": []any{offer2}})
	emitLegacy(owner, Object{"kind": "select", "offerId": offer2})
	emitLegacy(author, Object{"kind": "confirm"})
	emitLegacy(owner, Object{"kind": "change-scope", "scope": "Mutually revised scope", "reason": "Explicit revision"})
	emitLegacy(author, Object{"kind": "confirm-scope"})
	delivery1 := uuid.NewString()
	emitLegacy(author, Object{"kind": "deliver", "id": delivery1, "attemptId": attemptLegacy, "summary": "Participant reports a delivery", "evidenceIds": []any{}, "caseReviewVersion": 0})
	emitLegacy(owner, Object{"kind": "accept", "deliveryId": delivery1, "summary": "Requester acknowledges delivery"})
	emitLegacy(author, Object{"kind": "requester-feedback", "descriptionClarity": "clear", "scopeMatched": true, "note": "Provider report only"})
	emitLegacy(owner, Object{"kind": "dispute", "reason": "Record explicit dispute"})
	resolutionLegacy := uuid.NewString()
	emitLegacy(owner, Object{"kind": "propose-resolution", "id": resolutionLegacy, "summary": "Resume agreed work", "outcome": "resume-work"})
	emitLegacy(author, Object{"kind": "confirm-resolution", "proposalId": resolutionLegacy})
	delivery2 := uuid.NewString()
	emitLegacy(author, Object{"kind": "deliver", "id": delivery2, "attemptId": attemptLegacy, "summary": "Later reported delivery", "evidenceIds": []any{}, "caseReviewVersion": 0})
	emitLegacy(owner, Object{"kind": "accept", "deliveryId": delivery2, "summary": "Acknowledge later delivery"})
	var legacyState Object
	if e = ownerPool.QueryRow(ctx, "SELECT snapshot FROM assistance_requests WHERE id=$1", legacyID).Scan(&legacyState); e != nil || str(legacyState, "state") != "accepted" || str(legacyState, "agreedScope") != "Mutually revised scope" || obj(legacyState, "delivery")["id"] != delivery2 {
		t.Fatal("legacy current state changed", legacyState, e)
	}
	if _, e = svc.LegacyGet(ctx, Actor{Actor: author.Actor}, legacyID); e != nil {
		t.Fatal("legacy participant read", e)
	}
	if _, e = svc.GetTask(ctx, nil, legacyID); fault.Status(e) != 404 {
		t.Fatal("legacy private task exposed anonymously", e)
	}
	get := func(path string, who deviceauthfixture.Fixture, status int) Object {
		t.Helper()
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+who.Credential)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s status %d expected %d: %s", path, w.Code, status, w.Body.String())
		}
		var out Object
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	commentID := uuid.NewString()
	for i, kind := range []string{"create", "edit", "correct", "retract"} {
		operation := uuid.NewString()
		payload := Object{"schemaVersion": 2, "id": operation, "commentId": commentID, "taskId": tid, "expectedRevision": i, "kind": kind}
		if kind != "retract" {
			payload["body"], payload["visibility"] = "Selected task comment 😀 https://example.invalid", "inherit-task"
		}
		if kind == "correct" {
			payload["reason"] = "Explicit correction"
		}
		viewers := []string{author.Actor.SubjectID, moderator.Actor.SubjectID}
		if kind == "retract" {
			viewers = nil
		}
		grant := owner.Grant(t, payload, "comment.publish", operation, "Private", viewers)
		accepted := call("/v2/comments", grant, owner, 200)
		again := call("/v2/comments", grant, owner, 200)
		if accepted["operationId"] != again["operationId"] || num(accepted["revision"]) != int64(i+1) {
			t.Fatal("comment replay or revision", accepted, again)
		}
		receipt := call("/v2/comments/receipt", Object{"operationId": operation, "payloadHash": identity.Digest([]byte(grant["payloadJson"].(string)))}, owner, 200)
		if receipt["state"] != "acknowledged" {
			t.Fatal("comment receipt", receipt)
		}
		if i == 0 {
			get("/v2/comments/"+commentID, author, 503)
			comments.IsBlockedWithin = inbox.IsBlockedWithin
			visible := get("/v2/comments/"+commentID, author, 200)
			if visible["body"] == nil {
				t.Fatal("selected comment unavailable", visible)
			}
			options = call("/v2/notifications/options/read", Object{}, owner, 200)
			blocks := clone(obj(options, "settings"))
			blocks["blockedSubjectIds"] = []any{author.Actor.SubjectID}
			changed := call("/v2/notifications/options/save", Object{"expectedRevision": options["revision"], "settings": blocks}, owner, 200)
			blocked := get("/v2/comments/"+commentID, author, 200)
			if blocked["body"] != nil || blocked["state"] != "blocked" {
				t.Fatal("current block exposed comment", blocked)
			}
			blocks = clone(obj(changed, "settings"))
			blocks["blockedSubjectIds"] = []any{}
			call("/v2/notifications/options/save", Object{"expectedRevision": changed["revision"], "settings": blocks}, owner, 200)
			reportID := uuid.NewString()
			report := Object{"schemaVersion": 2, "id": reportID, "target": Object{"type": "task-comment", "id": commentID, "revision": 1}, "category": "review-request", "summary": "Review selected comment"}
			reportGrant := owner.Grant(t, report, "moderation.publish", reportID, "Private", []string{moderator.Actor.SubjectID})
			reportResult := call("/v2/comment-governance/reports", reportGrant, owner, 200)
			reportReplay := call("/v2/comment-governance/reports", reportGrant, owner, 200)
			if reportResult["eventId"] != reportReplay["eventId"] || num(reportResult["version"]) != num(reportReplay["version"]) {
				t.Fatal("report ACK changed")
			}
			operations := []struct {
				who    deviceauthfixture.Fixture
				fields Object
			}{
				{moderator, Object{"kind": "pause", "until": devicefixture.Now + 600, "rule": "Temporary source review"}},
				{moderator, Object{"kind": "resume"}},
				{moderator, Object{"kind": "resolve", "verdict": "dismissed", "reviewDisposition": "approve", "rule": "Comment acceptable"}},
				{owner, Object{"kind": "appeal"}},
				{moderator, Object{"kind": "resolve", "verdict": "upheld", "reviewDisposition": "reject", "rule": "Changed disposition"}},
			}
			for index, entry := range operations {
				id := uuid.NewString()
				event := Object{"schemaVersion": 2, "id": id, "reportId": reportID, "expectedVersion": index + 1, "summary": "Independent operator process"}
				for key, value := range entry.fields {
					event[key] = value
				}
				viewer := owner.Actor.SubjectID
				if entry.who.Actor.SubjectID == viewer {
					viewer = moderator.Actor.SubjectID
				}
				authorization := entry.who.Grant(t, event, "moderation.publish", id, "Private", []string{viewer})
				path := "/v2/comment-governance/" + reportID + "/events"
				recorded := call(path, authorization, entry.who, 200)
				replayed := call(path, authorization, entry.who, 200)
				if recorded["eventId"] != replayed["eventId"] || num(recorded["version"]) != num(replayed["version"]) {
					t.Fatal("moderation ACK changed", recorded, replayed)
				}
				r := call("/v2/comment-governance/receipt", Object{"operationId": id, "payloadHash": identity.Digest([]byte(authorization["payloadJson"].(string)))}, entry.who, 200)
				if r["state"] != "acknowledged" {
					t.Fatal("moderation receipt", r)
				}
				get("/v2/comment-governance/"+reportID, entry.who, 200)
			}
			// A separately bound notifications-only session may read the current
			// governance Inbox projection without obtaining moderation authority.
			binding, err := moderator.Service.BindingChallenge(ctx, deviceauth.BindingInput{SubjectID: moderator.Materials.Genesis.ID, GenesisProof: moderator.Materials.Genesis.GenesisProof, InstallationID: uuid.NewString(), Scopes: []string{"binding", "notifications"}, Control: &deviceauth.BindingControl{DeviceID: moderator.Materials.DeviceID, KeyID: identity.Digest([]byte(moderator.Materials.PublicKeyPEM)), Epoch: 1}}, true)
			if err != nil {
				t.Fatal(err)
			}
			private, err := identity.PrivatePEM([]byte(moderator.Materials.OwnerPrivate))
			if err != nil {
				t.Fatal(err)
			}
			sign := func(payload, typ string) string {
				t.Helper()
				v, err := identity.SignIdentityPayload(private, payload, typ)
				if err != nil {
					t.Fatal(err)
				}
				return v
			}
			bound, err := moderator.Service.Bind(ctx, deviceauth.BindInput{Challenge: binding["challenge"], ClientSession: binding["clientSession"], Signature: sign(binding["challenge"], "galaxy-binding-response+jws")}, nil)
			if err != nil {
				t.Fatal(err)
			}
			secret := make([]byte, 32)
			if _, err = rand.Read(secret); err != nil {
				t.Fatal(err)
			}
			credential := base64.RawURLEncoding.EncodeToString(secret)
			challenge, err := moderator.Service.Challenge(ctx, deviceauth.ChallengeInput{BindingID: bound.BindingID, CredentialHash: identity.Digest([]byte(credential))})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = moderator.Service.Activate(ctx, deviceauth.ActivateInput{Challenge: challenge["challenge"], Signature: sign(challenge["challenge"], "galaxy-session-response+jws")}, nil); err != nil {
				t.Fatal(err)
			}
			limited := moderator
			limited.Credential = credential
			if _, err = ownerPool.Exec(ctx, "UPDATE comment_governance_events_v2 SET created_at=to_timestamp($2) WHERE report_id=$1", reportID, devicefixture.Now); err != nil {
				t.Fatal(err)
			}
			limitedInbox := call("/v2/notifications/query", Object{}, limited, 200)
			found := false
			for _, value := range arr(limitedInbox["items"]) {
				item, _ := value.(map[string]any)
				found = found || strings.HasPrefix(str(item, "id"), "comment-governance:")
			}
			if !found {
				t.Fatal("notifications-only session missed current governance", limitedInbox)
			}
			get("/v2/comment-governance/"+reportID, limited, 401)
		}
	}
	if view := get("/v2/comments/"+commentID, owner, 200); view["body"] != nil || view["state"] != "retracted" {
		t.Fatal("retracted comment exposed body", view)
	}
	publicTask := clone(task)
	publicID, publicOperation := uuid.NewString(), uuid.NewString()
	publicTask["taskId"], publicTask["operationId"], publicTask["visibility"] = publicID, publicOperation, "Public"
	publicGrant := owner.Grant(t, publicTask, "assistance.publish", publicOperation, "Public", nil)
	call("/v2/tasks", publicGrant, owner, 200)
	publicComment, publicCommentOp := uuid.NewString(), uuid.NewString()
	publicBody := Object{"schemaVersion": 2, "id": publicCommentOp, "commentId": publicComment, "taskId": publicID, "expectedRevision": 0, "kind": "create", "body": "Publicly selected comment", "visibility": "inherit-task"}
	publicCommentGrant := owner.Grant(t, publicBody, "comment.publish", publicCommentOp, "Public", nil)
	call("/v2/comments", publicCommentGrant, owner, 200)
	anonymous := func() Object {
		t.Helper()
		r := httptest.NewRequest("GET", "/v2/comments/"+publicComment, nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("public comment %d %s", w.Code, w.Body.String())
		}
		var out Object
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	if visible := anonymous(); visible["body"] != "Publicly selected comment" {
		t.Fatal("anonymous public projection", visible)
	}
	if _, e = owner.Service.RevokeConsent(ctx, owner.Actor, publicCommentGrant["consentId"].(string), nil); e != nil {
		t.Fatal(e)
	}
	if hidden := anonymous(); hidden["body"] != nil {
		t.Fatal("revoked public comment remained visible", hidden)
	}
	// Both the signed identity and the official-account event feed consult the
	// current Task source; withdrawal must stop subsequent public delivery.
	consumers := webevents.PublicConsumers{Task: svc.EventRead, PublicTask: svc.PublicEventRead}
	sources := &webevents.PublicSources{Pool: pool, Endpoint: endpoint, Consumers: consumers}
	change := webevents.Event{Module: "tasks", SourceTable: "task_requests", Ref: Object{"id": publicID}}
	principal := webevents.Principal{Surface: "web", Endpoint: endpoint, Kind: "device", Actor: owner.Actor, Identity: owner.Actor.SubjectID, SubjectID: owner.Actor.SubjectID}
	if decision, err := sources.AuthorizeSource(ctx, principal, change); err != nil || decision != webevents.Allowed {
		t.Fatal("signed Task event source unavailable", decision, err)
	}
	var accountID string
	if e = ownerPool.QueryRow(ctx, "SELECT id::text FROM community_accounts WHERE endpoint=$1 AND external_subject='task-owner'", endpoint).Scan(&accountID); e != nil {
		t.Fatal(e)
	}
	principal.Kind, principal.Actor, principal.Identity, principal.SubjectID, principal.AccountID = "official-account", nil, accountID, "", accountID
	if decision, err := sources.AuthorizeSource(ctx, principal, change); err != nil || decision != webevents.Allowed {
		t.Fatal("public Task event source unavailable", decision, err)
	}
	if _, e = owner.Service.RevokeConsent(ctx, owner.Actor, publicGrant["consentId"].(string), nil); e != nil {
		t.Fatal(e)
	}
	if decision, err := sources.AuthorizeSource(ctx, principal, change); err != nil || decision != webevents.Denied {
		t.Fatal("event feed ignored Task source withdrawal", decision, err)
	}
	// Source revocation removes current Task authority but leaves its original
	// exact operation and human presentation receipts recoverable.
	if _, e = owner.Service.RevokeConsent(ctx, owner.Actor, create["consentId"].(string), nil); e != nil {
		t.Fatal(e)
	}
	if _, e = svc.GetTask(ctx, &Actor{Actor: owner.Actor}, tid); fault.Status(e) != 403 {
		t.Fatal("revoked task source stayed readable", e)
	}
	receipt := call("/v2/tasks/receipt", Object{"taskId": tid, "eventId": op, "payloadHash": identity.Digest([]byte(create["payloadJson"].(string)))}, owner, 200)
	if receipt["state"] != "acknowledged" {
		t.Fatal("original task receipt lost", receipt)
	}
	ack := call("/v2/notifications/presentation/ack", claim, owner, 200)
	if !truth(ack["presented"]) || !truth(ack["read"]) {
		t.Fatal("source withdrawal erased human receipt", ack)
	}
}

