package taskmaterials

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/accountlinkfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/chatarchivefixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type outcomeTestStore struct {
	dir       string
	loseErase bool
	loseHead  bool
	erases    int
}

func (s *outcomeTestStore) KeyID() string { return "outcome-isolated-key" }
func (s *outcomeTestStore) path(key string) string {
	return filepath.Join(s.dir, base64.RawURLEncoding.EncodeToString([]byte(key)))
}
func (s *outcomeTestStore) Put(_ context.Context, key string, b []byte, hash string) error {
	if attachments.Digest(b) != hash {
		return errors.New("digest mismatch")
	}
	return os.WriteFile(s.path(key), b, 0600)
}
func (s *outcomeTestStore) Get(_ context.Context, key, kid string, size int64) ([]byte, error) {
	if kid != s.KeyID() {
		return nil, errors.New("incorrect key")
	}
	b, e := os.ReadFile(s.path(key))
	if os.IsNotExist(e) {
		return nil, nil
	}
	return b, e
}
func (s *outcomeTestStore) Head(ctx context.Context, key, kid string) (*attachments.Head, error) {
	if s.loseHead {
		s.loseHead = false
		return nil, errors.New("synthetic head unavailable")
	}
	b, e := s.Get(ctx, key, kid, 0)
	if e != nil || b == nil {
		return nil, e
	}
	hash := attachments.Digest(b)
	return &attachments.Head{Size: int64(len(b)), SHA256: &hash}, nil
}
func (s *outcomeTestStore) Erase(_ context.Context, key string) error {
	s.erases++
	e := os.Remove(s.path(key))
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if s.loseErase {
		s.loseErase = false
		s.loseHead = true
		return errors.New("synthetic lost delete acknowledgment")
	}
	return nil
}

type outcomeTestScanner struct{}

func (outcomeTestScanner) Scan(context.Context, []byte) (map[string]any, error) {
	return Object{"state": "clean", "checkedAt": devicefixture.Now}, nil
}
func outcomeEnvelope(t *testing.T, f deviceauthfixture.Fixture, payload Object, viewers []string) Envelope {
	t.Helper()
	g := f.Grant(t, payload, "outcome.material", str(payload, "id"), "Private", viewers)
	return Envelope{ConsentID: str(g, "consentId"), PayloadJSON: str(g, "payloadJson")}
}

func TestOutcomeCurrentChatSourcesIndependentCopyAndRemoval(t *testing.T) {
	ctx := context.Background()
	pool, _ := testsupport.PostgreSQL(t)
	if _, err := databaseschema.Migrate(ctx, pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	if _, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		if err := objectremoval.MigrateWithin(ctx, tx); err != nil {
			return false, err
		}
		return true, objectremoval.ProvisionRolesWithin(ctx, tx)
	}); err != nil {
		t.Fatal(err)
	}
	scopes := []string{"binding", "consent", "history", "evidence", "case-teaser", "data-export"}
	owner := deviceauthfixture.New(t, pool, t.TempDir(), scopes)
	author := deviceauthfixture.New(t, pool, t.TempDir(), scopes)
	if _, err := pool.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3)`, devicefixture.Endpoint, operationsrules.EmptyControls(), time.Unix(devicefixture.Now, 0)); err != nil {
		t.Fatal(err)
	}
	linksFixture := accountlinkfixture.New(t, pool, owner.Service)
	linksFixture.Link(owner, "outcome-owner")
	linksFixture.Link(author, "outcome-author")
	now := func() time.Time { return time.Unix(devicefixture.Now, 0) }
	devices := owner.Service
	links := &accountlinks.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, Providers: []accountlinks.Provider{{Issuer: linksFixture.Issuer, ClientID: "galaxy-fixture"}}, Now: now}
	archive := chatarchivefixture.New(t)
	transport, err := chat.NewComponentTransport("xmpp://"+archive.Listener.Addr().String(), "gateway.example.invalid", "rooms.example.invalid", chatarchivefixture.Secret, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err = transport.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer transport.Stop()
	chatService := &chat.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, Links: links, Transport: transport, Rules: &businessrules.Service{Endpoint: devicefixture.Endpoint, Now: now}, Now: now}
	store := &outcomeTestStore{dir: t.TempDir()}
	files := &chat.AttachmentService{Chat: chatService, Store: store, Scanner: outcomeTestScanner{}, Policy: attachments.DefaultPolicy()}
	chatService.Attachments = files
	ownerChat, authorChat := chat.Actor{Device: &owner.Actor}, chat.Actor{Device: &author.Actor}
	room := uuid.NewString()
	created, err := chatService.Create(ctx, ownerChat, jsonBytes(Object{"roomId": room, "operationId": uuid.NewString(), "title": "Selected source room"}))
	if err != nil {
		t.Fatal("room", err)
	}
	decision := uuid.NewString()
	if _, err = chatService.Propose(ctx, ownerChat, room, jsonBytes(Object{"decisionId": decision, "expectedRevision": created["revision"], "action": "invite", "targetSubjectId": author.Actor.SubjectID})); err != nil {
		t.Fatal(err)
	}
	if _, err = chatService.Accept(ctx, authorChat, room, jsonBytes(Object{"decisionId": decision})); err != nil {
		t.Fatal(err)
	}
	caseSource := &cases.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, Now: now}
	caseID := uuid.NewString()
	root := Object{"schemaVersion": 2, "kind": "case-created", "eventId": caseID, "caseId": caseID, "expectedVersion": 0, "actorId": owner.Actor.SubjectID, "localRef": "isolated-" + caseID, "title": "Selected result copy", "summary": "Explicit local fixture", "source": Object{"kind": "local", "reference": "isolated"}, "synthetic": true}
	if _, err = caseSource.SubmitV2(ctx, owner.Actor, jsonBytes(owner.Grant(t, root, "case.teaser.publish", caseID, "Private", nil)), ""); err != nil {
		t.Fatal("case", err)
	}
	message, err := chatService.Send(ctx, authorChat, room, jsonBytes(Object{"clientMessageId": uuid.NewString(), "text": "Explicitly selected message 😀"}))
	if err != nil {
		t.Fatal("message", err)
	}
	messageID := str(message, "messageId")
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := chatService.ReadSelectedWithin(ctx, tx, ownerChat, messageID, 1)
	tx.Rollback(ctx)
	if err != nil {
		t.Fatal("selected message", err)
	}
	data := []byte("Original isolated attachment bytes\n")
	attachmentID := uuid.NewString()
	sha := attachments.Digest(data)
	if _, err = files.Prepare(ctx, authorChat, jsonBytes(Object{"attachmentId": attachmentID, "roomId": room, "name": "result.txt", "mediaType": "text/plain", "size": len(data), "sha256": sha, "purpose": "temporary-room-attachment", "confirmed": true})); err != nil {
		t.Fatal("prepare", err)
	}
	if _, err = files.Upload(ctx, authorChat, attachmentID, io.NopCloser(bytes.NewReader(data)), int64(len(data)), "application/octet-stream", nil); err != nil {
		t.Fatal("upload", err)
	}
	if _, err = files.ScanPending(ctx, 1); err != nil {
		t.Fatal("scan", err)
	}
	if _, err = chatService.Send(ctx, authorChat, room, jsonBytes(Object{"clientMessageId": uuid.NewString(), "text": "Selected attachment", "attachments": []any{Object{"id": attachmentID, "sha256": sha}}})); err != nil {
		t.Fatal("publish attachment", err)
	}
	service := &Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, CaseWithin: caseSource.CaseWithin, Now: now}
	outcome := &OutcomeService{Service: service, Store: store, Removals: &objectremoval.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Now: now}, ReadMessage: func(ctx context.Context, tx pgx.Tx, a Actor, id string, revision int64) (Object, error) {
		return chatService.ReadSelectedWithin(ctx, tx, chat.Actor{Device: &a.Actor}, id, revision)
	}, RecheckMessage: func(ctx context.Context, tx pgx.Tx, a Actor, room, id string, revision int64) (Object, error) {
		return chatService.RequireSelectedWithin(ctx, tx, chat.Actor{Device: &a.Actor}, room, id, revision)
	}, SelectAttachment: func(ctx context.Context, tx pgx.Tx, a Actor, id string) (SelectedSource, error) {
		r, b, e := files.SelectAttachmentWithin(ctx, tx, chat.Actor{Device: &a.Actor}, id)
		if e != nil {
			return SelectedSource{}, e
		}
		return SelectedSource{Source: Object{"kind": "attachment", "id": r["id"], "version": 1, "sha256": r["sha256"], "roomId": r["room_id"]}, AuthorID: str(r, "subject_id"), Size: int64(len(b)), Bytes: b, Name: str(r, "name"), MediaType: str(r, "media_type")}, nil
	}, InspectAttachment: func(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
		return files.InspectAttachmentWithin(ctx, tx, chat.Actor{Device: &a.Actor}, id)
	}}
	ownerActor, authorActor := Actor{Actor: owner.Actor}, Actor{Actor: author.Actor}
	propose := func(source Object, title string) (string, Envelope) {
		t.Helper()
		request := Object{"id": uuid.NewString(), "materialId": uuid.NewString(), "kind": "request", "source": source, "caseId": caseID, "purpose": "Selected outcome copy", "title": title, "audience": Object{"visibility": "Private", "viewers": []string{author.Actor.SubjectID}}, "uses": []string{"evidence"}, "retention": "with-related-result; independently-authorized-copy", "requestExpiresAt": now().Add(time.Hour).Format("2006-01-02T15:04:05.000Z")}
		requestEnvelope := outcomeEnvelope(t, owner, request, []string{author.Actor.SubjectID})
		first, e := outcome.Request(ctx, ownerActor, requestEnvelope)
		if e != nil {
			t.Fatal("outcome request", e)
		}
		if str(first.(Object), "state") != "requested" {
			t.Fatal(first)
		}
		replay, e := outcome.Request(ctx, ownerActor, requestEnvelope)
		if e != nil || !truth(replay.(Object)["replayed"]) {
			t.Fatal("lost request ack", replay, e)
		}
		receipt, e := outcome.Receipt(ctx, ownerActor, str(request, "id"), identity.Digest([]byte(requestEnvelope.PayloadJSON)))
		if e != nil || str(receipt.(Object), "state") != "recorded" {
			t.Fatal("receipt", receipt, e)
		}
		approval := Object{"id": uuid.NewString(), "materialId": request["materialId"], "kind": "approve", "expectedRevision": 1, "requestHash": identity.Digest([]byte(requestEnvelope.PayloadJSON)), "source": source, "license": "authored-content", "basis": "authored-content", "scope": "Exact selected fixture content", "independentRetention": true, "temporarySourceExpiryRevokesCopy": false}
		if _, e = outcome.Approve(ctx, authorActor, outcomeEnvelope(t, author, approval, []string{owner.Actor.SubjectID})); e != nil {
			t.Fatal("author approval", e)
		}
		control := Object{"id": uuid.NewString(), "materialId": request["materialId"], "kind": "revoke", "expectedRevision": 2, "reason": "Explicit fixture revoke"}
		return str(request, "materialId"), outcomeEnvelope(t, author, control, nil)
	}
	messageCopy, _ := propose(Object{"kind": "message", "id": messageID, "version": 1, "sha256": selected["contentHash"], "roomId": room}, "Message result")
	attachmentCopy, control := propose(Object{"kind": "attachment", "id": attachmentID, "version": 1, "sha256": sha, "roomId": room}, "Attachment result")
	read, e := outcome.Read(ctx, ownerActor, attachmentCopy)
	if e != nil || !truth(read.(Object)["contentAvailable"]) || str(read.(Object), "bytesBase64") != base64.StdEncoding.EncodeToString(data) {
		t.Fatal("copy bytes", read, e)
	}
	// The device fixture uses a fixed 2033 application clock while PostgreSQL
	// uses its real transaction clock for export cutoffs; place these synthetic
	// rows before that cutoff without altering their consent or content.
	if _, err = pool.Exec(ctx, "UPDATE outcome_materials_v2 SET created_at=transaction_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])", []string{messageCopy, attachmentCopy}); err != nil {
		t.Fatal(err)
	}
	lifecycle := &subjectlifecycle.Service{Pool: pool, Endpoint: devicefixture.Endpoint, Devices: devices, Now: now, OutcomeMaterials: func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, id string) (Object, error) {
		return outcome.ReadWithin(ctx, tx, Actor{Actor: a.Actor}, id)
	}}
	la := subjectlifecycle.Actor{Actor: owner.Actor}
	exportID := uuid.NewString()
	if _, e = lifecycle.Create(ctx, la, subjectlifecycle.CreateInput{ID: exportID, Datasets: []string{"outcome-materials-v2"}}); e != nil {
		t.Fatal("export", e)
	}
	input := subjectlifecycle.BinaryInput{ID: exportID, Dataset: "outcome-materials-v2", RecordID: attachmentCopy}
	binary, e := lifecycle.Binary(ctx, la, input)
	if e != nil || str(binary.(Object), "contentBase64") != base64.StdEncoding.EncodeToString(data) {
		t.Fatal("lifecycle binary", binary, e)
	}
	if _, e = pool.Exec(ctx, "UPDATE chat_message_refs SET expires_at=$2 WHERE message_id=$1", messageID, now().Add(-time.Second)); e != nil {
		t.Fatal(e)
	}
	read, e = outcome.Read(ctx, ownerActor, messageCopy)
	if e != nil || !truth(read.(Object)["contentAvailable"]) {
		t.Fatal("source TTL revoked independent copy", read, e)
	}
	if _, e = outcome.Control(ctx, authorActor, control); e != nil {
		t.Fatal("revoke", e)
	}
	read, e = outcome.Read(ctx, ownerActor, attachmentCopy)
	if e != nil || truth(read.(Object)["contentAvailable"]) {
		t.Fatal("revoked copy", read, e)
	}
	binary, e = lifecycle.Binary(ctx, la, input)
	if e != nil || truth(binary.(Object)["binaryContentAvailable"]) {
		t.Fatal("revoked lifecycle bytes", binary, e)
	}
	store.loseErase = true
	if _, e = outcome.purgeCopies(ctx, 100); e == nil {
		t.Fatal("expected lost deletion acknowledgment")
	}
	if store.erases != 1 {
		t.Fatal("first delete dispatch", store.erases)
	}
	var firstOperation, firstState string
	if e = pool.QueryRow(ctx, `SELECT operation_id::text,state FROM galaxy_go_storage.object_removals_v1 WHERE endpoint=$1 AND domain='outcome' AND object_id=$2`, devicefixture.Endpoint, attachmentCopy).Scan(&firstOperation, &firstState); e != nil || firstOperation == "" || firstState != "result-unknown" {
		t.Fatal("unknown removal receipt", firstOperation, firstState, e)
	}
	if _, e = outcome.purgeCopies(ctx, 100); e != nil {
		t.Fatal("reconcile removal", e)
	}
	var afterOperation, afterState string
	if e = pool.QueryRow(ctx, `SELECT operation_id::text,state FROM galaxy_go_storage.object_removals_v1 WHERE endpoint=$1 AND domain='outcome' AND object_id=$2`, devicefixture.Endpoint, attachmentCopy).Scan(&afterOperation, &afterState); e != nil || afterOperation != firstOperation || afterState != "absent" {
		t.Fatal("reconciled removal receipt", afterOperation, afterState, e)
	}
	if store.erases != 1 {
		t.Fatal("unknown delete was resent", store.erases)
	}
	b, e := store.Get(ctx, "outcome-materials/"+attachmentCopy, store.KeyID(), 0)
	if e != nil || b != nil {
		t.Fatal("copy not erased", e)
	}
	var rooms int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM chat_rooms WHERE room_id=$1", room).Scan(&rooms); e != nil || rooms != 1 {
		t.Fatal("source room changed", rooms, e)
	}
}
