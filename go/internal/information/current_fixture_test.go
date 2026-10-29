package information

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"testing"
	"time"
)

const fixtureEndpoint = "https://information.example.invalid"
const fixtureClock int64 = 2000000000

func informationGrant(t *testing.T, p deviceauthfixture.Fixture, payload Object, action, objectID string) Object {
	t.Helper()
	raw := encode(payload)
	fields := []string{}
	for key := range payload {
		fields = append(fields, key)
	}
	intent := deviceauth.ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: p.Actor.SubjectID, BindingID: p.Actor.BindingID, Endpoint: fixtureEndpoint, ObjectID: objectID, Action: action, Purpose: "operational", Recipient: fixtureEndpoint, Fields: fields, Visibility: "Private", Viewers: []string{}, PayloadHash: identity.Digest(raw), PolicyVersion: "0.1", IssuedAt: fixtureClock, ExpiresAt: fixtureClock + 3600}
	key, e := identity.PrivatePEM([]byte(p.Materials.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	signed, e := identity.SignIdentityPayload(key, string(encode(intent)), "galaxy-consent+jws")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = p.Service.CaptureConsent(context.Background(), p.Actor, signed); e != nil {
		t.Fatal(e)
	}
	return Object{"consentId": intent.ID, "payloadJson": string(raw)}
}
func setup(t *testing.T) (*pgxpool.Pool, *pgxpool.Pool, string, fixture) {
	t.Helper()
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	scopes := []string{"binding", "consent", "case-teaser", "notifications", "history", "proof", "assistance", "builders"}
	person := deviceauthfixture.NewEndpoint(t, owner, t.TempDir(), scopes, fixtureEndpoint)
	if _, e := databaseschema.Migrate(ctx, owner, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	config := owner.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	api, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(api.Close)
	now := func() time.Time { return time.Unix(fixtureClock, 0) }
	var f fixture
	f.Endpoint = fixtureEndpoint
	f.Clock = fixtureClock
	f.Owner.Subject = person.Actor.SubjectID
	f.Owner.Token = person.Credential
	f.Owner.BindingID = person.Actor.BindingID
	id := uuid.NewString()
	f.Root = Object{"kind": "case-created", "eventId": id, "caseId": id, "actorId": person.Actor.SubjectID, "expectedVersion": 0, "localRef": uuid.NewString(), "title": "Private selected watch source", "summary": "Current authorized source only", "source": Object{"kind": "local", "reference": uuid.NewString()}, "synthetic": false}
	f.RootGrant = informationGrant(t, person, f.Root, "case.teaser.publish", id)
	cs := &cases.Service{Pool: api, Endpoint: fixtureEndpoint, Devices: person.Service, Now: now}
	if _, e = cs.SubmitV2(ctx, person.Actor, encode(f.RootGrant), ""); e != nil {
		t.Fatal(e)
	}
	id = uuid.NewString()
	f.NewCase = copyObject(f.Root)
	f.NewCase["eventId"], f.NewCase["caseId"], f.NewCase["localRef"], f.NewCase["source"] = id, id, uuid.NewString(), Object{"kind": "local", "reference": uuid.NewString()}
	f.NewCaseGrant = informationGrant(t, person, f.NewCase, "case.teaser.publish", id)
	f.Task = Object{"operationId": uuid.NewString(), "taskId": uuid.NewString(), "caseId": nil, "intent": "proactive-review", "workContext": Object{"goal": "Selected source", "currentSituation": "An original private request", "attemptRefs": []any{}}, "title": "Watch selected Task", "summary": "No inferred success", "visibility": "Private", "collaboration": "open-assistance", "enrollmentExpiresAt": fixtureClock + 3600}
	taskGrant := informationGrant(t, person, f.Task, "assistance.publish", text(f.Task, "operationId"))
	tasks := &taskmaterials.Service{Pool: api, Endpoint: fixtureEndpoint, Devices: person.Service, Now: now}
	if _, e = tasks.CreateTask(ctx, taskmaterials.Actor{Actor: person.Actor}, taskmaterials.TaskSubmission{ConsentID: text(taskGrant, "consentId"), PayloadJSON: text(taskGrant, "payloadJson")}); e != nil {
		t.Fatal(e)
	}
	close := Object{"taskId": f.Task["taskId"], "event": Object{"eventId": uuid.NewString(), "expectedTaskVersion": 1, "kind": "close", "reason": "Would terminate the source", "terminationIntent": "terminate-task"}}
	f.CloseGrant = informationGrant(t, person, close, "assistance.publish", text(obj(close["event"]), "eventId"))
	sources := []any{Object{"key": "history", "source": Object{"kind": "search", "request": Object{"type": "history", "query": Object{"subjectId": person.Actor.SubjectID, "limit": 1}}}}, Object{"key": "task", "source": Object{"kind": "search", "request": Object{"type": "task", "query": Object{"view": "requested", "limit": 1}}}}, Object{"key": "proof", "source": Object{"kind": "search", "request": Object{"type": "proof", "query": Object{"limit": 1}}}}, Object{"key": "worker", "source": Object{"kind": "search", "request": Object{"type": "worker", "query": Object{"limit": 1}}}}}
	watches := &Watches{Pool: api, Devices: person.Service, Now: now}
	for i := 0; i < 2; i++ {
		command := Object{"operationId": uuid.NewString(), "watchId": uuid.NewString(), "expectedRevision": 0, "action": "start", "plan": Object{"purpose": "Selected permitted information", "sources": sources, "expiresAt": fixtureClock + 7200}}
		result, e := watches.Command(ctx, person.Actor, encode(command), "")
		if e != nil {
			t.Fatal(e)
		}
		f.Watches = append(f.Watches, struct{ Command, Result Object }{command, result})
	}
	f.Simple = Object{"operationId": uuid.NewString(), "watchId": uuid.NewString(), "expectedRevision": 0, "action": "start", "plan": Object{"purpose": "Current source changes", "sources": sources[:1], "expiresAt": fixtureClock + 7200}}
	raw, _ := json.Marshal(f.Simple)
	_ = json.Unmarshal(raw, &f.Daily)
	f.Daily["operationId"], f.Daily["watchId"] = uuid.NewString(), uuid.NewString()
	obj(f.Daily["plan"])["report"] = Object{"mode": "daily", "utcMinute": 1}
	return owner, api, dsn, f
}
