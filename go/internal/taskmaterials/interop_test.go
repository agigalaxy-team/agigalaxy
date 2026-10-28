package taskmaterials

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/agigalaxy-team/agigalaxy/go/internal/webevents"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type fixtureBridge struct {
	t   *testing.T
	URL string
}

func (b fixtureBridge) call(ctx context.Context, action string, value any) (Object, error) {
	raw := jsonBytes(Object{"action": action, "value": value})
	r, _ := http.NewRequestWithContext(ctx, "POST", b.URL, bytes.NewReader(raw))
	r.Header.Set("Content-Type", "application/json")
	response, e := http.DefaultClient.Do(r)
	if e != nil {
		return nil, e
	}
	defer response.Body.Close()
	var out struct {
		Result Object
		Error  string
	}
	if e = json.NewDecoder(response.Body).Decode(&out); e != nil {
		return nil, e
	}
	if response.StatusCode != 200 {
		return nil, fmt.Errorf("original fixture %s: %s", action, out.Error)
	}
	return out.Result, nil
}

type bridgeStore struct{ fixtureBridge }

func (s bridgeStore) KeyID() string { return "isolated-key" }
func (s bridgeStore) Put(ctx context.Context, key string, bytes []byte, hash string) error {
	_, e := s.call(ctx, "store-put", Object{"key": key, "bytesBase64": base64.StdEncoding.EncodeToString(bytes), "sha256": hash})
	return e
}
func (s bridgeStore) Get(ctx context.Context, key, keyID string, size int64) ([]byte, error) {
	r, e := s.call(ctx, "store-get", Object{"key": key, "keyId": keyID, "size": size})
	if e != nil {
		return nil, e
	}
	if r["bytesBase64"] == nil {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(str(r, "bytesBase64"))
}
func (s bridgeStore) Erase(ctx context.Context, key string) error {
	_, e := s.call(ctx, "store-erase", Object{"key": key})
	return e
}

type bridgeTransport struct{ fixtureBridge }

func (t bridgeTransport) Available() bool { return true }
func (t bridgeTransport) Command(ctx context.Context, action string, payload chat.Object) (chat.Object, error) {
	return t.call(ctx, "transport", Object{"action": action, "payload": payload})
}

type fixtureScanner struct{}
type fixtureParticipation struct {
	Owner, Proposal bool
	ParticipationID string
	Input           Envelope
}

func (fixtureScanner) Scan(context.Context, []byte) (map[string]any, error) {
	return Object{"state": "clean", "fixtureOnly": true}, nil
}

type queryErrorLog struct{ t *testing.T }

func (q queryErrorLog) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	return ctx
}
func (q queryErrorLog) TraceQueryEnd(_ context.Context, _ *pgx.Conn, d pgx.TraceQueryEndData) {
	var e *pgconn.PgError
	if errors.As(d.Err, &e) {
		q.t.Logf("database %s: %s", e.Code, e.Message)
	}
}
func equalJSON(t *testing.T, a, b any, label string) {
	t.Helper()
	if canonical(a) != canonical(b) {
		t.Fatalf("%s differs from original JSON", label)
	}
}
func firstJSONDifference(left, right any, path string) string {
	if reflect.DeepEqual(left, right) {
		return ""
	}
	if a, ok := left.(map[string]any); ok {
		if b, ok := right.(map[string]any); ok {
			keys := []string{}
			for key := range a {
				keys = append(keys, key)
			}
			for key := range b {
				if _, ok := a[key]; !ok {
					keys = append(keys, key)
				}
			}
			sort.Strings(keys)
			for _, key := range keys {
				if difference := firstJSONDifference(a[key], b[key], path+"."+key); difference != "" {
					return difference
				}
			}
		}
	}
	if a, ok := left.([]any); ok {
		if b, ok := right.([]any); ok {
			if len(a) != len(b) {
				return fmt.Sprintf("%s length Go=%d original=%d", path, len(a), len(b))
			}
			for i := range a {
				if difference := firstJSONDifference(a[i], b[i], fmt.Sprintf("%s[%d]", path, i)); difference != "" {
					return difference
				}
			}
		}
	}
	return fmt.Sprintf("%s Go=%v original=%v", path, left, right)
}

func TestOriginalMaterialTaskOutcomeAndSharedQuotas(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 140*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/task-materials-interop.mjs"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_MATERIAL_DIR="+dir)
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	stdin, e := cmd.StdinPipe()
	if e != nil {
		t.Fatal(e)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() {
		_, _ = io.WriteString(stdin, "stop\n")
		_ = stdin.Close()
		if e := cmd.Wait(); e != nil && ctx.Err() == nil {
			t.Errorf("fixture process: %v %s", e, stderr.String())
		}
	}()
	ready := bufio.NewScanner(stdout)
	isReady := false
	for ready.Scan() {
		if ready.Text() == "ready" {
			isReady = true
			break
		}
	}
	if !isReady {
		t.Fatalf("fixture start: %s", stderr.String())
	}
	var f struct {
		Endpoint       string
		Now            int64
		Issuer, Bridge string
		Owner, Author  struct{ SubjectID, Token, AccountID string }
		Moderator      struct{ SubjectID, Token string }
		Task           struct {
			Prepared Object
			Request  Object
			Input    TaskSubmission
			Post     Object
		}
		RoomID              string
		Message, Attachment struct {
			Request                    Object
			Envelope, Approve, Control Envelope
		}
		AttachmentBytesBase64 string
		CaseLink              Object
		TaskEvents            []struct {
			Owner bool
			Input Envelope
		}
		ParticipationCommands []fixtureParticipation
		CommentCommands       []Envelope
		GovernanceCommands    []struct {
			Owner bool
			Input Envelope
		}
		Legacy struct {
			Request  Object
			Input    Envelope
			Commands []struct {
				Owner bool
				Input Envelope
			}
		}
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "fixture.json"))
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	api, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	cfg := api.Config()
	api.Close()
	cfg.ConnConfig.Tracer = queryErrorLog{t}
	api, e = pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	now := func() time.Time { return time.Unix(f.Now, 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: f.Endpoint, Now: now}
	links := &accountlinks.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Providers: []accountlinks.Provider{{Issuer: f.Issuer, ClientID: "galaxy-fixture"}}, Now: now}
	writes := &publicwrites.Service{Pool: api, Endpoint: f.Endpoint, Links: links, Now: now}
	forum := &community.Service{Pool: api, Endpoint: f.Endpoint, DeviceAuth: devices, AccountLinks: links, Now: now}
	caseSource := &cases.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	configurationSource := &configurations.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	caseSource.ConfigurationCondition = configurationSource.ConditionWithin
	service := &Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Writes: writes, Now: now, Forum: ForumSourceAdapter(forum.TaskMaterialSourceWithin), OwnedCaseLive: caseSource.RequireOwnedCaseLiveWithin, CaseWithin: caseSource.CaseWithin}
	service.CaseOwnerSource = caseSource.RequireOwnerSourceWithin
	caseSource.TaskRead = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
		return service.RequireTaskWithin(ctx, tx, &a, id, false)
	}
	caseSource.TaskWrite = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (Object, error) {
		return service.RequireTaskWithin(ctx, tx, &a, id, true)
	}
	caseSource.Participation = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, task, id string) (Object, error) {
		return service.RequireParticipationWithin(ctx, tx, a, task, id, false)
	}
	caseSource.AttachCase = service.AttachCaseWithin
	bridge := fixtureBridge{t, f.Bridge}
	store := bridgeStore{bridge}
	chatService := &chat.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Links: links, Transport: bridgeTransport{bridge}, Now: now, Rules: &businessrules.Service{Endpoint: f.Endpoint, Now: now}}
	files := &chat.AttachmentService{Chat: chatService, Store: store, Scanner: fixtureScanner{}}
	outcome := &OutcomeService{Service: service, Store: store, Erase: store.Erase,
		ReadMessage: func(ctx context.Context, tx pgx.Tx, a Actor, id string, revision int64) (Object, error) {
			return chatService.ReadSelectedWithin(ctx, tx, chat.Actor{Device: &a.Actor}, id, revision)
		},
		RecheckMessage: func(ctx context.Context, tx pgx.Tx, a Actor, room, id string, revision int64) (Object, error) {
			return chatService.RequireSelectedWithin(ctx, tx, chat.Actor{Device: &a.Actor}, room, id, revision)
		},
		SelectAttachment: func(ctx context.Context, tx pgx.Tx, a Actor, id string) (SelectedSource, error) {
			r, b, e := files.SelectAttachmentWithin(ctx, tx, chat.Actor{Device: &a.Actor}, id)
			if e != nil {
				return SelectedSource{}, e
			}
			return SelectedSource{Source: Object{"kind": "attachment", "id": r["id"], "version": 1, "sha256": r["sha256"], "roomId": r["room_id"]}, AuthorID: str(r, "subject_id"), Size: int64(len(b)), Bytes: b, Name: str(r, "name"), MediaType: str(r, "media_type")}, nil
		},
		InspectAttachment: func(ctx context.Context, tx pgx.Tx, a Actor, id string) (Object, error) {
			return files.InspectAttachmentWithin(ctx, tx, chat.Actor{Device: &a.Actor}, id)
		},
	}
	comments := &CommentService{Service: service}
	governance := &CommentGovernance{CommentService: comments, ModeratorIDs: []string{f.Moderator.SubjectID}}
	inbox := &notifications.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}
	inbox.Readers = notifications.CurrentReaders{Task: service.NotificationReadWithin, Assistance: service.LegacyNotificationReadWithin, Comment: comments.NotificationReadWithin, CommentGovernance: governance.NotificationReadWithin, Chat: func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, c notifications.Object) (notifications.Object, error) {
		return chatService.NotificationViewWithin(ctx, tx, a, str(c, "kind"), str(c, "event_id"), str(c, "room_id"))
	}}
	server := httptest.NewServer(notifications.Handler{Service: inbox, Next: CommentGovernanceHandler{Service: governance, Next: CommentHandler{Service: comments, Next: Handler{Task: service, Outcome: outcome, Next: cases.Handler{Service: caseSource, Devices: devices, Next: publicwrites.Handler{Service: writes}}}}}})
	defer server.Close()
	call := func(path string, input any, token string, status int) Object {
		t.Helper()
		var body io.Reader
		method := "GET"
		if input != nil {
			body = bytes.NewReader(jsonBytes(input))
			method = "POST"
		}
		r, _ := http.NewRequestWithContext(ctx, method, server.URL+path, body)
		if input != nil {
			r.Header.Set("Content-Type", "application/json")
		}
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		response, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		var out Object
		if e = json.NewDecoder(response.Body).Decode(&out); e != nil {
			t.Fatal(e)
		}
		if response.StatusCode != status {
			t.Fatalf("%s status %d expected %d error %s", path, response.StatusCode, status, str(out, "error"))
		}
		return out
	}
	// The original OIDC/Consent producer supplies source commitments and a signed
	// root. Go owns validation, same-tx grant/material storage and the quota write.
	created := call("/v2/tasks", f.Task.Input, f.Owner.Token, 200)
	if created["taskId"] != f.Task.Request["taskId"] {
		t.Fatal("task identity changed")
	}
	repeated := call("/v2/tasks", f.Task.Input, f.Owner.Token, 200)
	if repeated["eventId"] != created["eventId"] {
		t.Fatal("unknown create replay changed operation")
	}
	goTask := call("/v2/tasks/"+str(f.Task.Request, "taskId"), nil, f.Owner.Token, 200)
	original, e := bridge.call(ctx, "read-task", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, goTask, original, "task current projection")
	goStatus := call("/v2/tasks/"+str(f.Task.Request, "taskId")+"/materials/status", nil, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "status-task", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, goStatus, original, "task material status")
	link := call("/v2/tasks/"+str(f.Task.Request, "taskId")+"/case", f.CaseLink, f.Owner.Token, 200)
	linkReplay := call("/v2/tasks/"+str(f.Task.Request, "taskId")+"/case", f.CaseLink, f.Owner.Token, 200)
	equalJSON(t, link, linkReplay, "unknown Case link acknowledgment")
	if num(link["taskVersion"]) != 1 || num(link["caseVersion"]) != 2 || num(link["failedAttemptsCreated"]) != 0 {
		t.Fatal("Case link changed task version or invented work")
	}
	quota := call("/v2/account/quotas", Object{}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "quota", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, quota, original, "shared quota status")
	// Shared quota is transactional and exactly replayable across the old
	// producer and the migrated Task/comment/invitation consumers.
	quotaActor, e := devices.Authenticate(ctx, f.Owner.Token, "assistance")
	if e != nil {
		t.Fatal(e)
	}
	publicActor := publicwrites.Actor{Device: &quotaActor, Scope: "assistance"}
	comment := publicwrites.Operation{Kind: "comment", OperationID: uuid.NewString(), PayloadHash: strings.Repeat("c", 64), TaskID: str(f.Task.Request, "taskId")}
	rollback := errors.New("isolated caller rollback")
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
		_, e := writes.ConsumeWithin(ctx, tx, publicActor, comment)
		if e != nil {
			return nil, e
		}
		return nil, rollback
	})
	if !errors.Is(e, rollback) {
		t.Fatal(e)
	}
	afterRollback, e := writes.Status(ctx, publicwrites.Actor{Device: &quotaActor, Scope: "binding"})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, afterRollback, quota, "quota rollback")
	consumed, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return writes.ConsumeWithin(ctx, tx, publicActor, comment) })
	if e != nil {
		t.Fatal(e)
	}
	original, e = bridge.call(ctx, "consume", Object{"kind": comment.Kind, "operationId": comment.OperationID, "payloadHash": comment.PayloadHash, "taskId": comment.TaskID})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, consumed, original, "cross-runtime quota replay")
	conflict := comment
	conflict.PayloadHash = strings.Repeat("d", 64)
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return writes.ConsumeWithin(ctx, tx, publicActor, conflict) })
	if fault.Code(e) != "public_write_conflict" {
		t.Fatal("quota operation conflict lost", e)
	}
	invitation := publicwrites.Operation{Kind: "invitation", OperationID: uuid.NewString(), PayloadHash: strings.Repeat("e", 64), TaskID: str(f.Task.Request, "taskId"), RecipientID: f.Author.SubjectID}
	if _, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return writes.ConsumeWithin(ctx, tx, publicActor, invitation) }); e != nil {
		t.Fatal(e)
	}
	invitation.OperationID = uuid.NewString()
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) { return writes.ConsumeWithin(ctx, tx, publicActor, invitation) })
	if fault.Code(e) != "invitation_cooldown" || publicwrites.Details(e)["retryAfterSeconds"] == nil {
		t.Fatal("current invitation cooldown missing", e)
	}
	_, e = bridge.call(ctx, "consume", Object{"kind": invitation.Kind, "operationId": invitation.OperationID, "payloadHash": invitation.PayloadHash, "taskId": invitation.TaskID, "recipientId": invitation.RecipientID})
	if e == nil || !strings.Contains(e.Error(), "invitation_cooldown") {
		t.Fatal("original cooldown differs", e)
	}
	if _, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
		return nil, writes.MarkInvitationRespondedWithin(ctx, tx, publicwrites.Targets{TaskID: invitation.TaskID, RecipientID: invitation.RecipientID})
	}); e != nil {
		t.Fatal(e)
	}
	for eventIndex, command := range f.TaskEvents {
		if eventIndex == 4 {
			commands := f.ParticipationCommands
			inserted := false
			for commandIndex := 0; commandIndex < len(commands); commandIndex++ {
				if commandIndex == 6 && !inserted {
					delivery, e := bridge.call(ctx, "delivery", Object{})
					if e != nil {
						t.Fatal(e)
					}
					var deliver, accept Envelope
					_ = json.Unmarshal(jsonBytes(delivery["deliver"]), &deliver)
					_ = json.Unmarshal(jsonBytes(delivery["accept"]), &accept)
					id := commands[0].ParticipationID
					call("/v2/participations/"+id+"/events", deliver, f.Author.Token, 503)
					service.ValidateDelivery = func(ctx context.Context, tx pgx.Tx, a Actor, in DeliveryInput) error {
						_, e := caseSource.ValidateDeliveryWithin(ctx, tx, a.Actor, cases.DeliveryInput{TaskID: in.TaskID, CaseID: in.CaseID, ParticipationID: in.ParticipationID, SubjectID: in.SubjectID, ScopeVersion: &in.ScopeVersion, ResultRef: in.ResultRef, InterventionRefs: in.InterventionRefs, EvidenceRefs: in.EvidenceRefs})
						return e
					}
					more := []fixtureParticipation{{ParticipationID: id, Input: deliver}, {Owner: true, ParticipationID: id, Input: accept}}
					commands = append(commands[:6:6], append(more, commands[6:]...)...)
					inserted = true
				}
				command := commands[commandIndex]
				var taskPrior, partPrior Object
				if e = owner.QueryRow(ctx, "SELECT snapshot FROM task_requests WHERE id=$1", f.Task.Request["taskId"]).Scan(&taskPrior); e != nil {
					t.Fatal(e)
				}
				if !command.Proposal {
					if e = owner.QueryRow(ctx, "SELECT snapshot FROM task_participations WHERE id=$1", command.ParticipationID).Scan(&partPrior); e != nil {
						t.Fatal(e)
					}
				}
				event, _ := parseObject(command.Input.PayloadJSON)
				actor, token := f.Author.SubjectID, f.Author.Token
				if command.Owner {
					actor, token = f.Owner.SubjectID, f.Owner.Token
				}
				expected, e := bridge.call(ctx, "participation-transition", Object{"proposal": command.Proposal, "task": taskPrior, "state": partPrior, "actor": actor, "event": event})
				if e != nil {
					t.Fatal(e)
				}
				path := "/v2/participations/" + command.ParticipationID + "/events"
				if command.Proposal {
					path = "/v2/tasks/" + str(f.Task.Request, "taskId") + "/participations"
				}
				accepted := call(path, command.Input, token, 200)
				replay := call(path, command.Input, token, 200)
				if accepted["eventId"] != replay["eventId"] || num(accepted["version"]) != num(replay["version"]) {
					t.Fatal("participation unknown acknowledgment changed")
				}
				var taskActual, partActual Object
				if e = owner.QueryRow(ctx, "SELECT snapshot FROM task_requests WHERE id=$1", f.Task.Request["taskId"]).Scan(&taskActual); e != nil {
					t.Fatal(e)
				}
				if e = owner.QueryRow(ctx, "SELECT snapshot FROM task_participations WHERE id=$1", command.ParticipationID).Scan(&partActual); e != nil {
					t.Fatal(e)
				}
				equalJSON(t, taskActual, expected["task"], "participation parent Task reducer")
				equalJSON(t, partActual, expected["participation"], "participation original state")
				goView := call("/v2/tasks/"+str(f.Task.Request, "taskId"), nil, f.Owner.Token, 200)
				original, e = bridge.call(ctx, "read-task", Object{})
				if e != nil {
					t.Fatal(e)
				}
				equalJSON(t, goView, original, "participation current Task view")
			}
		}
		var prior Object
		if e = owner.QueryRow(ctx, "SELECT snapshot FROM task_requests WHERE id=$1", f.Task.Request["taskId"]).Scan(&prior); e != nil {
			t.Fatal(e)
		}
		payload, _ := parseObject(command.Input.PayloadJSON)
		event := obj(payload, "event")
		actor, token := f.Author.SubjectID, f.Author.Token
		if command.Owner {
			actor, token = f.Owner.SubjectID, f.Owner.Token
		}
		expected, e := bridge.call(ctx, "task-transition", Object{"state": prior, "actor": actor, "event": event})
		if e != nil {
			t.Fatal(e)
		}
		path := "/v2/tasks/" + str(f.Task.Request, "taskId") + "/events"
		accepted := call(path, command.Input, token, 200)
		replay := call(path, command.Input, token, 200)
		if accepted["eventId"] != replay["eventId"] || num(accepted["version"]) != num(replay["version"]) {
			t.Fatal("task event unknown acknowledgment changed")
		}
		var actual Object
		if e = owner.QueryRow(ctx, "SELECT snapshot FROM task_requests WHERE id=$1", f.Task.Request["taskId"]).Scan(&actual); e != nil {
			t.Fatal(e)
		}
		equalJSON(t, actual, expected, "original Task event state")
		goView := call("/v2/tasks/"+str(f.Task.Request, "taskId"), nil, f.Owner.Token, 200)
		original, e = bridge.call(ctx, "read-task", Object{})
		if e != nil {
			t.Fatal(e)
		}
		equalJSON(t, goView, original, "Task event current read")
	}
	noticeQuery := call("/v2/notifications/query", Object{}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "inbox-query", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, noticeQuery, original, "current Inbox sources")
	var claim Object
	for _, value := range noticeQuery["items"].([]any) {
		notice := value.(map[string]any)
		if truth(notice["interruptiveEligible"]) && strings.HasPrefix(str(notice, "id"), "task-v2:") {
			claim = Object{"id": notice["id"], "deliveryClientId": uuid.NewString(), "claimId": uuid.NewString()}
			break
		}
	}
	if claim == nil {
		t.Fatal("actual Task source notice missing")
	}
	claimed := call("/v2/notifications/presentation/claim", claim, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "inbox-claim", claim)
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, claimed, original, "same-client display claim replay")
	otherClaim := clone(claim)
	otherClaim["deliveryClientId"] = uuid.NewString()
	otherClaim["claimId"] = uuid.NewString()
	notClaimed := call("/v2/notifications/presentation/claim", otherClaim, f.Owner.Token, 200)
	if truth(notClaimed["claimed"]) {
		t.Fatal("two clients claimed one active presentation")
	}
	shown := call("/v2/notifications/presentation/ack", claim, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "inbox-presented", claim)
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, shown, original, "client display receipt")
	if truth(shown["read"]) || truth(shown["humanReadChanged"]) {
		t.Fatal("client display forged human read")
	}
	call("/v2/notifications/read", Object{"id": claim["id"], "reader": "assistant"}, f.Owner.Token, 400)
	call("/v2/notifications/read", Object{"id": claim["id"], "reader": "human"}, f.Owner.Token, 200)
	oneNotice, e := bridge.call(ctx, "inbox-one", Object{"id": claim["id"]})
	if e != nil || !truth(oneNotice["read"]) {
		t.Fatal("human notification read did not persist", e)
	}
	prefs := call("/v1/notifications/preferences/read", Object{}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "notification-preferences", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, prefs, original, "legacy preferences")
	settings := clone(obj(prefs, "settings"))
	settings["discovery"] = Object{"enabled": true, "purposes": []string{"conversation"}, "functions": []string{}, "temporary": nil}
	original, e = bridge.call(ctx, "notification-save", Object{"expectedRevision": prefs["revision"], "settings": settings})
	if e != nil {
		t.Fatal(e)
	}
	oldClient := clone(obj(original, "settings"))
	delete(oldClient, "discovery")
	saved := call("/v1/notifications/preferences/save", Object{"expectedRevision": original["revision"], "settings": oldClient}, f.Owner.Token, 200)
	if !truth(obj(obj(saved, "settings"), "discovery")["enabled"]) {
		t.Fatal("old notification client removed current discovery declaration")
	}
	original, e = bridge.call(ctx, "notification-preferences", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, saved, original, "old-client preferences preservation")
	legacy := call("/v1/notifications/query", Object{}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "notification-query", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, legacy, original, "legacy source query")
	archiveInput := Object{"expectedRevision": saved["revision"], "before": f.Now}
	archived := call("/v1/notifications/archive", archiveInput, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "notification-archive", archiveInput)
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, archived, original, "unknown archive acknowledgment")
	options := call("/v2/notifications/options/read", Object{}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "inbox-options", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, options, original, "current Inbox options")
	settingsOptions := clone(obj(options, "settings"))
	settingsOptions["tasks"] = false
	muted := call("/v2/notifications/options/save", Object{"expectedRevision": options["revision"], "settings": settingsOptions}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "inbox-options", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, muted, original, "current Inbox options write")
	quietInbox := call("/v2/notifications/query", Object{}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "inbox-query", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, quietInbox, original, "Task mute changes interruption eligibility")
	rewind := Object{"expectedRevision": archived["revision"], "before": f.Now - 1}
	call("/v1/notifications/archive", rewind, f.Owner.Token, 409)
	if _, e = bridge.call(ctx, "notification-archive", rewind); e == nil || !strings.Contains(e.Error(), "notification_archive_cannot_rewind") {
		t.Fatal("archive rewind diverged", e)
	}
	for i := 0; i < 2; i++ {
		wire, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (json.RawMessage, error) {
			if e := devices.AuthorizeWithin(ctx, tx, quotaActor, "history"); e != nil {
				return nil, e
			}
			return service.ReadHistoryWireWithin(ctx, tx, &quotaActor, str(f.Task.Request, "taskId"))
		})
		if e != nil {
			t.Fatal(e)
		}
		original, e = bridge.call(ctx, "task-history-wire", Object{})
		if e != nil {
			t.Fatal(e)
		}
		if string(wire) != str(original, "json") {
			want := str(original, "json")
			offset := 0
			for offset < len(wire) && offset < len(want) && wire[offset] == want[offset] {
				offset++
			}
			t.Fatalf("original History Task nested wire order differs at %d: want %q got %q", offset, want[max(0, offset-35):min(len(want), offset+100)], string(wire[max(0, offset-35):min(len(wire), offset+100)]))
		}
		if i == 0 {
			if _, e = bridge.call(ctx, "history-revoke-scope", Object{}); e != nil {
				t.Fatal(e)
			}
		}
	}
	proofSource := &evidence.ProofService{}
	historySource := &historyv2.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Cases: caseSource, Records: &verificationrecords.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Cases: caseSource, Proofs: proofSource, Now: now}, Proofs: proofSource, Profiles: &profiles.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now}, Tasks: service.ReadHistoryWireWithin, Now: now}
	historyView, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
		return historySource.QueryWithin(ctx, tx, &quotaActor, jsonBytes(Object{"subjectId": f.Owner.SubjectID, "limit": 50}))
	})
	if e != nil {
		t.Fatal(e)
	}
	original, e = bridge.call(ctx, "history-v2", Object{})
	if e != nil {
		t.Fatal(e)
	}
	if canonical(historyView) != canonical(original) {
		var actual Object
		_ = json.Unmarshal(jsonBytes(historyView), &actual)
		t.Errorf("actual HistoryV2 current items/sourceHash differs: %s", firstJSONDifference(actual, original, "history"))
	}
	queryWire, e := service.QueryTasksWire(ctx, &Actor{Actor: quotaActor}, "requested", "", "", 12)
	if e != nil {
		t.Fatal(e)
	}
	original, e = bridge.call(ctx, "query-task-wire", Object{})
	if e != nil {
		t.Fatal(e)
	}
	if string(queryWire) != str(original, "json") {
		left, right := string(queryWire), str(original, "json")
		i := 0
		for i < len(left) && i < len(right) && left[i] == right[i] {
			i++
		}
		t.Fatalf("full Task query wire differs at byte %d Go=%s original=%s", i, left[max(0, i-50):min(len(left), i+130)], right[max(0, i-50):min(len(right), i+130)])
	}
	for _, material := range []struct {
		Request                    Object
		Envelope, Approve, Control Envelope
	}{f.Message, f.Attachment} {
		id := str(material.Request, "materialId")
		requested := call("/v2/outcome-materials/request", material.Envelope, f.Owner.Token, 200)
		if str(requested, "state") != "requested" {
			t.Fatal("request state changed")
		}
		replay := call("/v2/outcome-materials/request", material.Envelope, f.Owner.Token, 200)
		if !truth(replay["replayed"]) {
			t.Fatal("outcome request replay did not resolve")
		}
		call("/v2/outcome-materials/approve", material.Approve, f.Author.Token, 200)
		read := call("/v2/outcome-materials/read", Object{"id": id}, f.Owner.Token, 200)
		if !truth(read["contentAvailable"]) {
			t.Fatal("approved copy unavailable", read["reason"])
		}
		original, e = bridge.call(ctx, "read-outcome", Object{"id": id})
		if e != nil {
			t.Fatal(e)
		}
		equalJSON(t, read, original, "independent outcome read")
		receipt := call("/v2/outcome-materials/receipt", Object{"operationId": material.Request["id"], "payloadHash": identity.Digest([]byte(material.Envelope.PayloadJSON))}, f.Owner.Token, 200)
		if str(receipt, "state") != "recorded" {
			t.Fatal("accepted outcome operation missing")
		}
		if str(obj(material.Request, "source"), "kind") == "attachment" {
			if str(read, "bytesBase64") != f.AttachmentBytesBase64 {
				t.Fatal("original attachment bytes changed")
			}
			if _, e := store.Get(ctx, "outcome-materials/"+id, store.KeyID(), num(read["size"])); e != nil {
				t.Fatal(e)
			}
		}
	}
	// The real lifecycle service consumes these ports under its own data-export
	// authority. No extra evidence/assistance scope is requested by the reader.
	exportActor, e := devices.Authenticate(ctx, f.Owner.Token, "data-export")
	if e != nil {
		t.Fatal(e)
	}
	lifecycleActor := subjectlifecycle.Actor{Actor: exportActor}
	lifecycle := &subjectlifecycle.Service{Pool: api, Endpoint: f.Endpoint, Devices: devices, Now: now,
		Transforms: map[string]subjectlifecycle.Transformer{"task-materials": func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, item Object, _ int64) (Object, error) {
			return service.ExportMaterialWithin(ctx, tx, a.Actor, item)
		}},
		OutcomeMaterials: func(ctx context.Context, tx pgx.Tx, a subjectlifecycle.Actor, id string) (Object, error) {
			return outcome.ReadWithin(ctx, tx, Actor{Actor: a.Actor}, id)
		},
	}
	exportID := uuid.NewString()
	if _, e = lifecycle.Create(ctx, lifecycleActor, subjectlifecycle.CreateInput{ID: exportID, Datasets: []string{"task-materials", "outcome-materials-v2"}}); e != nil {
		t.Fatal(e)
	}
	page, e := lifecycle.Page(ctx, lifecycleActor, subjectlifecycle.PageInput{ID: exportID, Dataset: "task-materials"})
	if e != nil {
		t.Fatal(e)
	}
	var materialPage Object
	if e = json.Unmarshal(jsonBytes(page), &materialPage); e != nil {
		t.Fatal(e)
	}
	items, _ := materialPage["items"].([]any)
	if len(items) == 0 || !truth(items[0].(map[string]any)["contentAvailable"]) {
		t.Fatal("lifecycle task consumer missing current content")
	}
	binaryInput := subjectlifecycle.BinaryInput{ID: exportID, Dataset: "outcome-materials-v2", RecordID: str(f.Attachment.Request, "materialId")}
	binary, e := lifecycle.Binary(ctx, lifecycleActor, binaryInput)
	if e != nil {
		t.Fatal(e)
	}
	if str(binary.(map[string]any), "contentBase64") != f.AttachmentBytesBase64 {
		t.Fatal("lifecycle outcome bytes differ")
	}
	for i, command := range f.CommentCommands {
		accepted := call("/v2/comments", command, f.Owner.Token, 200)
		replay := call("/v2/comments", command, f.Owner.Token, 200)
		if accepted["operationId"] != replay["operationId"] || num(accepted["revision"]) != num(replay["revision"]) {
			t.Fatal("comment unknown acknowledgment changed")
		}
		p, _ := parseObject(command.PayloadJSON)
		id := str(p, "commentId")
		view := call("/v2/comments/"+id, nil, f.Owner.Token, 200)
		original, e = bridge.call(ctx, "comment-view", Object{"id": id})
		if e != nil {
			t.Fatal(e)
		}
		equalJSON(t, view, original, "comment current owner projection")
		anonymous := call("/v2/comments/"+id, nil, "", 200)
		original, e = bridge.call(ctx, "comment-view", Object{"id": id, "anonymous": true})
		if e != nil {
			t.Fatal(e)
		}
		equalJSON(t, anonymous, original, "comment current public projection")
		if i == 0 {
			call("/v2/comments/"+id, nil, f.Author.Token, 503)
			comments.IsBlockedWithin = inbox.IsBlockedWithin
			viewer := call("/v2/comments/"+id, nil, f.Author.Token, 200)
			original, e = bridge.call(ctx, "comment-view", Object{"id": id, "author": true})
			if e != nil {
				t.Fatal(e)
			}
			equalJSON(t, viewer, original, "comment current source consumer")
			if _, e = bridge.call(ctx, "block-comment-party", Object{}); e != nil {
				t.Fatal(e)
			}
			blocked := call("/v2/comments/"+id, nil, f.Author.Token, 200)
			original, e = bridge.call(ctx, "comment-view", Object{"id": id, "author": true})
			if e != nil {
				t.Fatal(e)
			}
			equalJSON(t, blocked, original, "comment symmetric current block")
			if blocked["body"] != nil || blocked["state"] != "blocked" {
				t.Fatal("current block leaked comment body")
			}
			for commandIndex, command := range f.GovernanceCommands {
				p, _ := parseObject(command.Input.PayloadJSON)
				reportID := str(p, "reportId")
				if commandIndex == 0 {
					reportID = str(p, "id")
				}
				token := f.Moderator.Token
				if command.Owner {
					token = f.Owner.Token
				}
				path := "/v2/comment-governance/" + reportID + "/events"
				if commandIndex == 0 {
					path = "/v2/comment-governance/reports"
				}
				accepted := call(path, command.Input, token, 200)
				replay := call(path, command.Input, token, 200)
				if accepted["eventId"] != replay["eventId"] || num(accepted["version"]) != num(replay["version"]) {
					t.Fatal("comment governance unknown acknowledgment changed")
				}
				for _, moderator := range []bool{false, true} {
					reader := f.Owner.Token
					if moderator {
						reader = f.Moderator.Token
					}
					view := call("/v2/comment-governance/"+reportID, nil, reader, 200)
					original, e = bridge.call(ctx, "governance-view", Object{"id": reportID, "moderator": moderator})
					if e != nil {
						t.Fatal(e)
					}
					equalJSON(t, view, original, "comment governance current permission and source")
				}
				query := call("/v2/comment-governance/query", Object{}, token, 200)
				original, e = bridge.call(ctx, "governance-query", Object{"moderator": !command.Owner})
				if e != nil {
					t.Fatal(e)
				}
				equalJSON(t, query, original, "comment governance query")
				receiptInput := Object{"operationId": p["id"], "payloadHash": identity.Digest([]byte(command.Input.PayloadJSON))}
				receipt := call("/v2/comment-governance/receipt", receiptInput, token, 200)
				receiptInput["moderator"] = !command.Owner
				original, e = bridge.call(ctx, "governance-receipt", receiptInput)
				if e != nil {
					t.Fatal(e)
				}
				equalJSON(t, receipt, original, "comment governance accepted receipt")
			}
		}
		query := call("/v2/comments/query", Object{"taskId": f.Task.Request["taskId"]}, f.Owner.Token, 200)
		original, e = bridge.call(ctx, "comment-query", Object{})
		if e != nil {
			t.Fatal(e)
		}
		equalJSON(t, query, original, "comment query current pages")
		receiptInput := Object{"operationId": p["id"], "payloadHash": identity.Digest([]byte(command.PayloadJSON))}
		receipt := call("/v2/comments/receipt", receiptInput, f.Owner.Token, 200)
		original, e = bridge.call(ctx, "comment-receipt", receiptInput)
		if e != nil {
			t.Fatal(e)
		}
		equalJSON(t, receipt, original, "original comment receipt")
	}
	if _, e = bridge.call(ctx, "expire-chat-source", Object{}); e != nil {
		t.Fatal(e)
	}
	retained := call("/v2/outcome-materials/read", Object{"id": f.Message.Request["materialId"]}, f.Owner.Token, 200)
	if !truth(retained["contentAvailable"]) {
		t.Fatal("original source TTL incorrectly revoked independent copy")
	}
	if _, e = bridge.call(ctx, "revoke-source", Object{}); e != nil {
		t.Fatal(e)
	}
	hidden := call("/v2/tasks/"+str(f.Task.Request, "taskId"), nil, "", 200)
	if str(obj(hidden, "request"), "title") != "" {
		t.Fatal("revoked source text survived public projection")
	}
	page, e = lifecycle.Page(ctx, lifecycleActor, subjectlifecycle.PageInput{ID: exportID, Dataset: "task-materials"})
	if e != nil {
		t.Fatal(e)
	}
	_ = json.Unmarshal(jsonBytes(page), &materialPage)
	items, _ = materialPage["items"].([]any)
	if len(items) != 0 && (truth(items[0].(map[string]any)["contentAvailable"]) || str(items[0].(map[string]any), "body_text") != "") {
		t.Fatal("lifecycle retained revoked source body")
	}
	call("/v2/tasks", f.Task.Input, f.Owner.Token, 200)
	if _, e = postgres.InTx(ctx, owner, func(tx pgx.Tx) (Object, error) { return service.CleanupWithin(ctx, tx, f.Now) }); e != nil {
		t.Fatal(e)
	}
	var bodyCount int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM task_materials_v1 WHERE task_id=$1 AND body_text<>''", f.Task.Request["taskId"]).Scan(&bodyCount); e != nil || bodyCount != 0 {
		t.Fatal("permanently revoked material body not erased", e)
	}
	call("/v2/outcome-materials/control", f.Attachment.Control, f.Author.Token, 200)
	revoked := call("/v2/outcome-materials/read", Object{"id": f.Attachment.Request["materialId"]}, f.Owner.Token, 200)
	if truth(revoked["contentAvailable"]) {
		t.Fatal("revoked outcome retained readable bytes")
	}
	binary, e = lifecycle.Binary(ctx, lifecycleActor, binaryInput)
	if e != nil {
		t.Fatal(e)
	}
	if truth(binary.(map[string]any)["binaryContentAvailable"]) {
		t.Fatal("lifecycle downloaded revoked outcome")
	}
	if _, e = postgres.InTx(ctx, owner, func(tx pgx.Tx) (Object, error) { return outcome.CleanupWithin(ctx, tx, f.Now, 100) }); e != nil {
		t.Fatal(e)
	}
	deleted, e := store.Get(ctx, "outcome-materials/"+str(f.Attachment.Request, "materialId"), store.KeyID(), 1)
	if e != nil || deleted != nil {
		t.Fatal("independent stored object not erased", e)
	}
	// No original room or unrelated source is removed by this copy cleanup.
	var rooms int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM chat_rooms WHERE room_id=$1", f.RoomID).Scan(&rooms); e != nil || rooms != 1 {
		t.Fatal("outcome cleanup changed source room")
	}
	// Event qualification uses the same actual domain read, including signed-ID
	// scope and the anonymous public path used for website account sessions.
	legacyID := str(f.Legacy.Request, "id")
	createdLegacy := call("/v1/assistance", f.Legacy.Input, f.Owner.Token, 200)
	legacyReplay := call("/v1/assistance", f.Legacy.Input, f.Owner.Token, 200)
	equalJSON(t, createdLegacy, legacyReplay, "legacy create unknown acknowledgment")
	for _, command := range f.Legacy.Commands {
		var prior Object
		if e = owner.QueryRow(ctx, "SELECT snapshot FROM assistance_requests WHERE id=$1", legacyID).Scan(&prior); e != nil {
			t.Fatal(e)
		}
		payload, _ := parseObject(command.Input.PayloadJSON)
		actor, token := f.Author.SubjectID, f.Author.Token
		if command.Owner {
			actor, token = f.Owner.SubjectID, f.Owner.Token
		}
		expected, e := bridge.call(ctx, "legacy-transition", Object{"state": prior, "actor": actor, "event": payload["event"]})
		if e != nil {
			t.Fatal(e)
		}
		accepted := call("/v1/assistance/"+legacyID+"/events", command.Input, token, 200)
		replay := call("/v1/assistance/"+legacyID+"/events", command.Input, token, 200)
		equalJSON(t, accepted, replay, "legacy event unknown acknowledgment")
		var current Object
		if e = owner.QueryRow(ctx, "SELECT snapshot FROM assistance_requests WHERE id=$1", legacyID).Scan(&current); e != nil {
			t.Fatal(e)
		}
		equalJSON(t, current, expected, "legacy original state reducer")
		for _, author := range []bool{false, true} {
			viewer := f.Owner.Token
			if author {
				viewer = f.Author.Token
			}
			view := call("/v1/assistance/"+legacyID, nil, viewer, 200)
			original, e = bridge.call(ctx, "legacy-read", Object{"author": author})
			if e != nil {
				t.Fatal(e)
			}
			equalJSON(t, view, original, "legacy current role projection")
		}
		event := obj(payload, "event")
		receiptInput := Object{"assistanceId": legacyID, "eventId": event["id"], "payloadHash": identity.Digest([]byte(command.Input.PayloadJSON))}
		receipt := call("/v1/assistance/events/receipt", receiptInput, token, 200)
		receiptInput["author"] = !command.Owner
		original, e = bridge.call(ctx, "legacy-receipt", receiptInput)
		if e != nil {
			t.Fatal(e)
		}
		equalJSON(t, receipt, original, "legacy event receipt")
	}
	legacyQuery := call("/v1/assistance/query", Object{"view": "requested"}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "legacy-query", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, legacyQuery, original, "legacy source pagination")
	legacyTask := call("/v2/tasks/"+legacyID, nil, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "legacy-task-read", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, legacyTask, original, "v2 route preserves legacy compatibility view")
	call("/v2/tasks/"+legacyID, nil, "", 404)
	legacyNotices := call("/v2/notifications/query", Object{}, f.Owner.Token, 200)
	original, e = bridge.call(ctx, "inbox-query", Object{})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, legacyNotices, original, "current legacy Assistance Inbox consumer")
	consumers := webevents.PublicConsumers{Task: service.EventRead, PublicTask: service.PublicEventRead}
	limited, e := bridge.call(ctx, "notifications-only-moderator", Object{})
	if e != nil {
		t.Fatal(e)
	}
	limitedToken := str(limited, "token")
	limitedInbox := call("/v2/notifications/query", Object{}, limitedToken, 200)
	original, e = bridge.call(ctx, "inbox-query", Object{"moderator": true})
	if e != nil {
		t.Fatal(e)
	}
	equalJSON(t, limitedInbox, original, "notifications-only credential uses current governance reader")
	sources := &webevents.PublicSources{Pool: api, Endpoint: f.Endpoint, Consumers: consumers}
	principal := webevents.Principal{Surface: "web", Endpoint: f.Endpoint, Kind: "device", Actor: quotaActor, Identity: quotaActor.SubjectID, SubjectID: quotaActor.SubjectID}
	change := webevents.Event{Module: "tasks", SourceTable: "task_requests", Ref: Object{"id": f.Task.Request["taskId"]}}
	if decision, e := sources.AuthorizeSource(ctx, principal, change); e != nil || decision != webevents.Allowed {
		t.Fatal("signed current Task event consumer unavailable", decision, e)
	}
	principal.Kind = "official-account"
	principal.Actor = nil
	principal.Identity = f.Owner.AccountID
	principal.SubjectID = ""
	principal.AccountID = f.Owner.AccountID
	if decision, e := sources.AuthorizeSource(ctx, principal, change); e != nil || decision != webevents.Allowed {
		t.Fatal("website public Task consumer unavailable", decision, e)
	}
	if _, e = bridge.call(ctx, "revoke-task-root", Object{}); e != nil {
		t.Fatal(e)
	}
	if decision, e := sources.AuthorizeSource(ctx, principal, change); e != nil || decision != webevents.Denied {
		t.Fatal("Task event consumer ignored root withdrawal", decision, e)
	}
	ackAfterWithdrawal := call("/v2/notifications/presentation/ack", claim, f.Owner.Token, 200)
	if !truth(ackAfterWithdrawal["presented"]) || !truth(ackAfterWithdrawal["read"]) {
		t.Fatal("source withdrawal erased owned display/human-read receipt")
	}
	recovered, e := bridge.call(ctx, "owner-recovery", Object{})
	if e != nil {
		t.Fatal(e)
	}
	recoveredTask := obj(recovered, "task")
	token := str(recovered, "token")
	id := str(recoveredTask, "taskId")
	preview := call("/v2/tasks/"+id+"/owner-read/prepare", Object{"operationId": recovered["operationId"]}, token, 200)
	equalJSON(t, preview, recovered["preview"], "recovered owner preview and literal descriptor")
	read := call("/v2/tasks/"+id+"/owner-read", recovered["request"], token, 200)
	equalJSON(t, read, recovered["read"], "recovered authored bytes")
	call("/v2/tasks/"+id, nil, token, 403)
	controlPreview := call("/v2/tasks/"+id+"/owner-control/prepare", recovered["controlInput"], token, 200)
	equalJSON(t, controlPreview, recovered["controlPreview"], "recovered control preview")
	controlled := call("/v2/tasks/"+id+"/owner-control", recovered["controlRequest"], token, 200)
	controlReplay := call("/v2/tasks/"+id+"/owner-control", recovered["controlRequest"], token, 200)
	equalJSON(t, controlled, controlReplay, "recovered owner control unknown acknowledgment")
	if controlled["state"] != "enrollment-stopped" || truth(controlled["currentAccessGranted"]) || truth(controlled["materialAccessChanged"]) {
		t.Fatal("recovery control broadened authorization")
	}
	call("/v2/tasks/"+id, nil, token, 403)
}
