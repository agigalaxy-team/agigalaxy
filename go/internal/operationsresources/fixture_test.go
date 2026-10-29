package operationsresources_test

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type resourcesFixture struct {
	Management *operationsfixture.Fixture
	Device     deviceauthfixture.Fixture
	Projects   *projects.Service
	Capsules   *capsules.Service
	Data       object
}

func (f *resourcesFixture) authorize(t *testing.T, value object, action, objectID string, public bool) object {
	t.Helper()
	raw := enc(value)
	fields := []string{}
	for key := range value {
		fields = append(fields, key)
	}
	visibility, purpose := "Private", "operational"
	if public {
		visibility, purpose = "Public", "public-profile"
	}
	intent := deviceauth.ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: f.Device.Actor.SubjectID, BindingID: f.Device.Actor.BindingID, Endpoint: f.Management.Endpoint, ObjectID: objectID, Action: action, Purpose: purpose, Recipient: f.Management.Endpoint, Fields: fields, Visibility: visibility, Viewers: []string{}, PayloadHash: identity.Digest(raw), PolicyVersion: "0.1", IssuedAt: 2000000000, ExpiresAt: 2000003600}
	key, err := identity.PrivatePEM([]byte(f.Device.Materials.OwnerPrivate))
	if err != nil {
		t.Fatal(err)
	}
	signed, err := identity.SignIdentityPayload(key, string(enc(intent)), "galaxy-consent+jws")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Device.Service.CaptureConsent(context.Background(), f.Device.Actor, signed); err != nil {
		t.Fatalf("capture %s: %v", action, err)
	}
	return object{"consentId": intent.ID, "payloadJson": string(raw)}
}

func newResourcesFixture(t *testing.T, owner *pgxpool.Pool) *resourcesFixture {
	t.Helper()
	ctx := context.Background()
	management := operationsfixture.New(t, owner)
	f := &resourcesFixture{Management: management, Data: object{}}
	f.Device = deviceauthfixture.NewEndpoint(t, owner, t.TempDir(), []string{"binding", "consent", "case-teaser", "capsules", "history", "evidence", "proof", "assistance"}, management.Endpoint)
	f.Device.Service.Pool = management.Pool
	devices := f.Device.Service
	cs := &cases.Service{Pool: management.Pool, Endpoint: management.Endpoint, Devices: devices, Now: management.Now}
	records := &verificationrecords.Service{Pool: management.Pool, Endpoint: management.Endpoint, Devices: devices, Cases: cs, Now: management.Now}
	f.Capsules = &capsules.Service{Pool: management.Pool, Endpoint: management.Endpoint, Devices: devices, Cases: cs, Records: records, Configurations: &configurations.Service{Pool: management.Pool, Endpoint: management.Endpoint, Devices: devices, Now: management.Now}, Now: management.Now}
	f.Projects = &projects.Service{Pool: management.Pool, Endpoint: management.Endpoint, Devices: devices, Now: management.Now}
	accountService := &accounts.Service{Endpoint: management.Endpoint, Now: management.Now}
	account, err := postgres.InTx(ctx, management.Pool, func(tx pgx.Tx) (accounts.Account, error) {
		a, err := accountService.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{Issuer: "https://resource-login.example.invalid", ExternalSubject: "resources-owner", VerificationMethod: "external-account", VerifiedAt: management.Now()})
		if err != nil {
			return a, err
		}
		kind := "person"
		_, err = accountService.EnsureProfileWithin(ctx, tx, a.ID, &kind)
		return a, err
	})
	if err != nil {
		t.Fatal(err)
	}
	// An already established synthetic account/controlled-ID association is
	// prerequisite data; the public project write rechecks this mapping in Go.
	link := uuid.NewString()
	if _, err = owner.Exec(ctx, `INSERT INTO external_identity_links(id,subject_id,binding_id,endpoint,provider_id,issuer,external_subject,client_id,payload_text,payload_hash,signature,created_at) VALUES($1,$2,$3,$4,'fixture','https://resource-login.example.invalid','resources-owner','resources-client','synthetic-established-mapping',$5,'synthetic-mapping-receipt',$6)`, link, f.Device.Actor.SubjectID, f.Device.Actor.BindingID, management.Endpoint, identity.Digest([]byte("synthetic-established-mapping")), management.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = owner.Exec(ctx, `INSERT INTO community_account_links(identity_link_id,account_id,subject_id,created_at) VALUES($1,$2,$3,$4)`, link, account.ID, f.Device.Actor.SubjectID, management.Now()); err != nil {
		t.Fatal(err)
	}
	f.Projects.Links = &accountlinks.Service{Pool: management.Pool, Endpoint: management.Endpoint, Devices: devices, Accounts: accountService, Providers: []accountlinks.Provider{{Issuer: "https://resource-login.example.invalid", ClientID: "resources-client"}}, Now: management.Now}
	project := object{"operationId": uuid.NewString(), "projectId": uuid.NewString(), "expectedRevision": 0, "kind": "create", "document": object{"kind": "module", "title": "原公开项目 🚀", "summary": "Current public signed source", "functions": []any{"parse"}, "discoverable": true, "extension": object{"z": 1, "a": 2}}}
	if _, err := f.Projects.Submit(ctx, projects.Actor{Device: &f.Device.Actor}, enc(f.authorize(t, project, "project.write", str(project["operationId"]), true))); err != nil {
		t.Fatalf("public project: %v", err)
	}
	caseID := uuid.NewString()
	subject := f.Device.Actor.SubjectID
	root := object{"schemaVersion": 2, "caseId": caseID, "actorId": subject, "kind": "case-created", "eventId": caseID, "expectedVersion": 0, "localRef": uuid.NewString(), "title": "Actual source", "summary": "Reported success source", "source": object{"kind": "local", "reference": uuid.NewString()}, "synthetic": true}
	attempt := object{"schemaVersion": 2, "caseId": caseID, "actorId": subject, "kind": "attempt-start", "eventId": uuid.NewString(), "expectedVersion": 1, "role": "implementation", "strategy": "Reported approach", "environment": object{"name": "Go", "version": "1"}, "inputScopeSummary": "Selected fixture", "permissionScope": []any{"test"}}
	result := object{"schemaVersion": 2, "caseId": caseID, "actorId": subject, "kind": "result-recorded", "eventId": uuid.NewString(), "expectedVersion": 2, "origin": object{"kind": "attempt", "id": attempt["eventId"], "version": 1}, "scopeVersion": 1, "deliverableRefs": []any{}, "reportedOutcome": "succeeded", "summary": "Original result", "limitations": "Fixture only"}
	for i, event := range []object{root, attempt, result} {
		if _, err := cs.SubmitV2(ctx, f.Device.Actor, enc(f.authorize(t, event, "case.teaser.publish", str(event["eventId"]), i == 0)), ""); err != nil {
			t.Fatalf("case event %d: %v", i, err)
		}
	}
	capsule := object{"schemaVersion": 2, "id": uuid.NewString(), "capsuleId": uuid.NewString(), "kind": "version", "expectedRevision": 0, "version": 1, "title": "原公开方法 🚀", "problemPattern": "Original pattern", "environment": object{"name": "Go", "version": "1"}, "solutionStrategy": "Original strategy", "tools": []any{}, "skills": []any{}, "mcpRefs": []any{}, "verificationMethod": "Reported", "limitations": []any{"Fixture"}, "capabilityId": "compiler", "applicableScope": "Selected synthetic Case", "license": "MIT", "contributors": []any{}, "sourceResolution": object{"caseId": caseID, "resultId": result["eventId"], "resultVersion": 1, "proofIds": []any{}, "verificationRefs": []any{}}, "redactionConfirmed": true, "publicationClass": "formal-source-success", "synthetic": true, "sourceRefs": []any{}, "permissionRefs": []any{}, "attributionRefs": []any{}, "externalReferences": []any{}}
	if _, err := f.Capsules.PublishV2(ctx, f.Device.Actor, enc(f.authorize(t, capsule, "capsule.publish", str(capsule["id"]), true)), ""); err != nil {
		t.Fatalf("public method: %v", err)
	}
	f.Data = object{"project": project, "capsule": capsule}
	return f
}

func (f *resourcesFixture) Change(t *testing.T, kind string) {
	t.Helper()
	ctx := context.Background()
	if kind == "private-method" {
		version := object{}
		for key, value := range obj(f.Data["capsule"]) {
			version[key] = value
		}
		version["id"], version["expectedRevision"], version["version"], version["title"] = uuid.NewString(), 1, 2, "Private latest method"
		if _, err := f.Capsules.PublishV2(ctx, f.Device.Actor, enc(f.authorize(t, version, "capsule.publish", str(version["id"]), false)), ""); err != nil {
			t.Fatal("private method", err)
		}
		notice := object{"schemaVersion": 2, "id": uuid.NewString(), "capsuleId": version["capsuleId"], "expectedRevision": 2, "versionId": version["id"], "summary": "Current maintenance flag", "kind": "deprecate"}
		if _, err := f.Capsules.PublishV2(ctx, f.Device.Actor, enc(f.authorize(t, notice, "capsule.publish", str(notice["id"]), false)), ""); err != nil {
			t.Fatal("method maintenance", err)
		}
		return
	}
	event := object{"operationId": uuid.NewString(), "projectId": obj(f.Data["project"])["projectId"]}
	switch kind {
	case "private-project":
		event["kind"], event["expectedRevision"], event["patch"] = "revise", 1, object{"summary": "Private current project"}
	case "archive-project":
		event["kind"], event["expectedRevision"] = "archive", 2
	default:
		t.Fatalf("unknown source transition %s", kind)
	}
	if _, err := f.Projects.Submit(ctx, projects.Actor{Device: &f.Device.Actor}, enc(f.authorize(t, event, "project.write", str(event["operationId"]), false))); err != nil {
		t.Fatalf("%s: %v", kind, err)
	}
}
