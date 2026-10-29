package identitygroups

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const groupEndpoint = "https://identity-group.example.invalid"
const groupClock int64 = 2000000000

type currentGroupFixture struct {
	people map[string]deviceauthfixture.Fixture
	meta   Object
}

func groupAuthorization(t *testing.T, f deviceauthfixture.Fixture, payload Object, action, objectID string) Object {
	t.Helper()
	raw := enc(payload)
	fields := []string{}
	for k := range payload {
		fields = append(fields, k)
	}
	intent := deviceauth.ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: f.Actor.SubjectID, BindingID: f.Actor.BindingID, Endpoint: groupEndpoint, ObjectID: objectID, Action: action, Purpose: "operational", Recipient: groupEndpoint, Fields: fields, Visibility: "Private", Viewers: []string{}, PayloadHash: identity.Digest(raw), PolicyVersion: "0.1", IssuedAt: groupClock, ExpiresAt: groupClock + 3600}
	key, e := identity.PrivatePEM([]byte(f.Materials.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	signed, e := identity.SignIdentityPayload(key, string(enc(intent)), "galaxy-consent+jws")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Service.CaptureConsent(context.Background(), f.Actor, signed); e != nil {
		t.Fatal(e)
	}
	return Object{"consentId": intent.ID, "payloadJson": string(raw)}
}
func newCurrentGroupFixture(t *testing.T, owner *pgxpool.Pool) *currentGroupFixture {
	t.Helper()
	ctx := context.Background()
	scopes := []string{"binding", "consent", "case-teaser", "history", "data-export", "data-delete"}
	f := &currentGroupFixture{people: map[string]deviceauthfixture.Fixture{}, meta: Object{"ready": true, "clock": groupClock, "endpoint": groupEndpoint}}
	actors := Object{}
	for _, name := range []string{"owner", "member", "stranger"} {
		person := legacyGroupIdentity(t, owner, scopes)
		f.people[name] = person
		actors[name] = Object{"subject": person.Actor.SubjectID, "token": person.Credential}
	}
	if _, e := databaseschema.Migrate(ctx, owner, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	f.meta["actors"] = actors
	now := func() time.Time { return time.Unix(groupClock, 0) }
	ownerActor := f.people["owner"]
	member := f.people["member"]
	cs := &cases.Service{Pool: owner, Endpoint: groupEndpoint, Devices: ownerActor.Service, Now: now}
	id := uuid.NewString()
	event := Object{"schemaVersion": 2, "kind": "case-created", "eventId": id, "caseId": id, "expectedVersion": 0, "actorId": ownerActor.Actor.SubjectID, "localRef": uuid.NewString(), "title": "SYNTHETIC exact identity attribution", "summary": "Private synthetic original author material", "synthetic": true, "source": Object{"kind": "local", "reference": uuid.NewString()}}
	grant := groupAuthorization(t, ownerActor, event, "case.teaser.publish", id)
	if _, e := cs.SubmitV2(ctx, ownerActor.Actor, enc(grant), ""); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile("../configurations/testdata/setup.json")
	if e != nil {
		t.Fatal(e)
	}
	var capture struct {
		Fixture struct {
			First Object `json:"first"`
		} `json:"fixture"`
	}
	if e = json.Unmarshal(raw, &capture); e != nil {
		t.Fatal(e)
	}
	config := capture.Fixture.First
	config["id"] = uuid.NewString()
	config["operationId"] = uuid.NewString()
	config["actorId"] = member.Actor.SubjectID
	cfg := &configurations.Service{Pool: owner, Endpoint: groupEndpoint, Devices: member.Service, Now: now}
	cg := groupAuthorization(t, member, config, "configuration.publish", txt(config, "operationId"))
	if _, e = cfg.Submit(ctx, member.Actor, enc(cg), ""); e != nil {
		t.Fatal(e)
	}
	f.meta["refs"] = []any{Object{"kind": "case-event", "id": id, "caseId": id, "version": 1, "sourceHash": identity.Digest([]byte(txt(grant, "payloadJson"))), "originalSubjectId": ownerActor.Actor.SubjectID}, Object{"kind": "configuration", "id": config["id"], "version": 1, "sourceHash": identity.Digest([]byte(txt(cg, "payloadJson"))), "originalSubjectId": member.Actor.SubjectID}}
	return f
}
func (f *currentGroupFixture) sign(t *testing.T, service *Service, who, signer string, intent Object, decision string) Object {
	t.Helper()
	person := f.people[who]
	current, e := service.Current(context.Background(), person.Actor)
	if e != nil {
		t.Fatal(e)
	}
	root, e := filepath.Abs("../../..")
	if e != nil {
		t.Fatal(e)
	}
	keyOwner := f.people[signer]
	input := Object{"materialPath": filepath.Join(keyOwner.Materials.Directory, "fixture.json"), "intent": intent, "current": current, "decision": decision, "clock": groupClock, "badSigner": who != signer}
	cmd := exec.Command("node", filepath.Join(root, "go/internal/identitygroups/testdata/current-client.mjs"))
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(enc(input))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, e := cmd.Output()
	if e != nil {
		t.Fatalf("current group signer: %v %s", e, stderr.String())
	}
	var value Object
	if e = json.Unmarshal(raw, &value); e != nil {
		t.Fatal(e)
	}
	return value
}

// Legacy binding is created through the real Go v1 flow so bootstrap exercises
// the original epoch-0 to epoch-1 upgrade instead of mutating authority rows.
func legacyGroupIdentity(t *testing.T, pool *pgxpool.Pool, scopes []string) deviceauthfixture.Fixture {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	m := devicefixture.NewEndpoint(t, pool, dir, groupEndpoint)
	svc, e := deviceauth.Load(ctx, pool, deviceauth.Configuration{Endpoint: groupEndpoint, SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(groupClock, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	key, e := identity.PrivatePEM([]byte(m.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	sign := func(payload, typ string) string {
		v, e := identity.SignIdentityPayload(key, payload, typ)
		if e != nil {
			t.Fatal(e)
		}
		return v
	}
	challenge, e := svc.BindingChallenge(ctx, deviceauth.BindingInput{SubjectID: m.Genesis.ID, GenesisProof: m.Genesis.GenesisProof, InstallationID: m.InstallationID, Scopes: scopes}, false)
	if e != nil {
		t.Fatal(e)
	}
	bound, e := svc.Bind(ctx, deviceauth.BindInput{Challenge: challenge["challenge"], Signature: sign(challenge["challenge"], "galaxy-binding-response+jws"), ClientSession: challenge["clientSession"]}, nil)
	if e != nil {
		t.Fatal(e)
	}
	secret := make([]byte, 32)
	if _, e = rand.Read(secret); e != nil {
		t.Fatal(e)
	}
	credential := base64.RawURLEncoding.EncodeToString(secret)
	preview, e := svc.Challenge(ctx, deviceauth.ChallengeInput{BindingID: bound.BindingID, CredentialHash: identity.Digest([]byte(credential))})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = svc.Activate(ctx, deviceauth.ActivateInput{Challenge: preview["challenge"], Signature: sign(preview["challenge"], "galaxy-session-response+jws")}, nil); e != nil {
		t.Fatal(e)
	}
	actor, e := svc.Authenticate(ctx, credential, "binding")
	if e != nil {
		t.Fatal(e)
	}
	return deviceauthfixture.Fixture{Materials: m, Service: svc, Actor: actor, Credential: credential}
}
func (f *currentGroupFixture) advanceOwner(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	p := f.people["owner"]
	service := p.Service
	key, e := identity.PrivatePEM([]byte(p.Materials.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	scopes := []string{"manage-identity", "binding", "consent", "case-teaser", "history", "data-export", "data-delete"}
	request := deviceauth.ControlRequest{Version: 2, OperationID: uuid.NewString(), SubjectID: p.Actor.SubjectID, Kind: "bootstrap", SignerKeyID: identity.Digest([]byte(p.Materials.PublicKeyPEM)), GenesisProof: p.Materials.Genesis.GenesisProof, NewDevice: &deviceauth.ControlDevice{DeviceID: p.Materials.DeviceID, PublicKeyPEM: p.Materials.PublicKeyPEM, Scopes: scopes}}
	raw, _ := json.Marshal(request)
	challenge, e := service.ControlChallenge(ctx, raw)
	if e != nil {
		t.Fatal(e)
	}
	sig, e := identity.SignIdentityPayload(key, challenge["challenge"].(string), "galaxy-identity-control-v2+jws")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = service.ControlCommit(ctx, deviceauth.ControlCommit{OperationID: request.OperationID, ControllerSignature: sig, NewDeviceProof: &sig}); e != nil {
		t.Fatal(e)
	}
	actor, e := service.Authenticate(ctx, p.Credential, "binding")
	if e != nil {
		t.Fatal(e)
	}
	p.Actor = actor
	f.people["owner"] = p
}
func TestCurrentGroupThreeIdentitiesAndControlAdvance(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := newCurrentGroupFixture(t, owner)
	if len(f.people) != 3 || len(arr(f.meta["refs"])) != 2 {
		t.Fatal("missing group fixtures")
	}
	f.advanceOwner(t)
	if f.people["owner"].Actor.ControlEpoch != 1 {
		t.Fatal("control did not advance")
	}
}
