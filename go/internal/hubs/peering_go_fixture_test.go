package hubs

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type goPeerFixture struct {
	auth deviceauthfixture.Fixture
	key  ed25519.PrivateKey
	meta Object
}

func (f *goPeerFixture) authorize(t *testing.T, value Object, action, objectID string, public bool) Object {
	return f.authorizeRaw(t, value, encode(value), action, objectID, public)
}
func (f *goPeerFixture) authorizeRaw(t *testing.T, value Object, raw []byte, action, objectID string, public bool) Object {
	t.Helper()
	ctx := context.Background()
	fields := make([]string, 0, len(value))
	for k := range value {
		fields = append(fields, k)
	}
	visibility, purpose := "Private", "operational"
	if public {
		visibility, purpose = "Public", "public-profile"
	}
	if objectID == "" {
		objectID = txt(value, "id")
	}
	intent := deviceauth.ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: f.auth.Actor.SubjectID, BindingID: f.auth.Actor.BindingID, Endpoint: txt(f.meta, "endpoint"), ObjectID: objectID, Action: action, Purpose: purpose, Recipient: txt(f.meta, "endpoint"), Fields: fields, Visibility: visibility, Viewers: []string{}, PayloadHash: identity.Digest(raw), PolicyVersion: "0.1", IssuedAt: 2000000000, ExpiresAt: 2000003600}
	signing, err := identity.PrivatePEM([]byte(f.auth.Materials.OwnerPrivate))
	if err != nil {
		t.Fatal(err)
	}
	signed, err := identity.SignIdentityPayload(signing, string(encode(intent)), "galaxy-consent+jws")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.auth.Service.CaptureConsent(ctx, f.auth.Actor, signed); err != nil {
		t.Fatalf("capture %s: %v", action, err)
	}
	return Object{"consentId": intent.ID, "payloadJson": string(raw)}
}
func (f *goPeerFixture) authorizePeering(t *testing.T, payload Object) Object {
	t.Helper()
	normalized, err := parsedWire("peeringEventSchema", encode(payload))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := wireEncode(normalized)
	if err != nil {
		t.Fatal(err)
	}
	return f.authorizeRaw(t, normalized.Values(), raw, "hub.publish", "", false)
}
func newGoPeerFixture(t *testing.T, owner *pgxpool.Pool, endpoint string, includeProof bool) *goPeerFixture {
	t.Helper()
	ctx := context.Background()
	scopes := []string{"binding", "consent", "builders", "case-teaser", "evidence", "proof", "history", "data-export", "data-delete"}
	auth := deviceauthfixture.NewEndpoint(t, owner, t.TempDir(), scopes, endpoint)
	if _, err := databaseschema.Migrate(ctx, owner, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	key, err := identity.PrivatePEM([]byte(auth.Materials.HubPrivate))
	if err != nil {
		t.Fatal(err)
	}
	f := &goPeerFixture{auth: auth, key: key, meta: Object{"endpoint": endpoint, "subject": auth.Actor.SubjectID, "token": auth.Credential, "pin": Object{"publicKeyPem": auth.Materials.HubPublic, "notBefore": int64(1999999999), "notAfter": int64(2000200000)}}}
	c := owner.Config()
	c.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	api, err := pgxpool.NewWithConfig(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(api.Close)
	now := func() time.Time { return time.Unix(2000000000, 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: endpoint, Now: now}
	bs := &builders.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now}
	hs := &Service{Pool: api, Endpoint: endpoint, Devices: devices, Builders: bs, Now: now}
	cs := &cases.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now}
	rs := &verificationrecords.Service{Pool: api, Endpoint: endpoint, Devices: devices, Cases: cs, Now: now}
	var template struct {
		Fixture Object              `json:"fixture"`
		Rows    map[string][]Object `json:"rows"`
	}
	raw, err := os.ReadFile("testdata/setup.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &template); err != nil {
		t.Fatal(err)
	}
	var oldBuilder Object
	if err = json.Unmarshal([]byte(txt(template.Rows["builder_events"][0], "payload_text")), &oldBuilder); err != nil {
		t.Fatal(err)
	}
	declaration := obj(oldBuilder["declaration"])
	declaration["endpoint"] = endpoint
	hubID := uuid.NewString()
	decl := Object{"id": uuid.NewString(), "builderId": hubID, "kind": "declare", "expectedRevision": 0, "declaration": declaration}
	declAuth := f.authorize(t, decl, "builder.publish", "", true)
	if _, err = bs.Publish(ctx, auth.Actor, encode(declAuth), ""); err != nil {
		t.Fatalf("builder: %v", err)
	}
	var oldCharter Object
	grant := obj(obj(template.Fixture["grants"])["charter"])
	if err = json.Unmarshal([]byte(txt(obj(grant["input"]), "payloadJson")), &oldCharter); err != nil {
		t.Fatal(err)
	}
	charter := Object{"schemaVersion": 2, "id": uuid.NewString(), "kind": "charter", "hubId": hubID, "expectedVersion": 0, "declarationId": decl["id"], "declarationHash": identity.Digest([]byte(txt(declAuth, "payloadJson"))), "charter": oldCharter["charter"]}
	if _, err = hs.Submit(ctx, auth.Actor, f.authorize(t, charter, "hub.publish", "", true), ""); err != nil {
		t.Fatalf("hub charter: %v", err)
	}
	f.meta["hubId"] = hubID
	if !includeProof {
		return f
	}
	rootID := uuid.NewString()
	root := Object{"schemaVersion": 2, "eventId": rootID, "caseId": rootID, "kind": "case-created", "expectedVersion": 0, "actorId": auth.Actor.SubjectID, "localRef": uuid.NewString(), "title": "PRIVATE_SYNTHETIC_TITLE", "summary": "PRIVATE_SYNTHETIC_CONTEXT", "source": Object{"kind": "local", "reference": uuid.NewString()}, "synthetic": true}
	if _, err = cs.SubmitV2(ctx, auth.Actor, encode(f.authorize(t, root, "case.teaser.publish", rootID, false)), ""); err != nil {
		t.Fatalf("case root: %v", err)
	}
	fact := Object{"schemaVersion": 2, "eventId": uuid.NewString(), "caseId": rootID, "kind": "intervention", "expectedVersion": 1, "actorId": auth.Actor.SubjectID, "types": []any{"diagnosis"}, "affectsAttemptIds": []any{}, "description": "PRIVATE_SYNTHETIC_DIAGNOSIS", "sourceRefs": []any{}, "observedEffect": "Only a reported observation"}
	factAuth := f.authorize(t, fact, "case.teaser.publish", txt(fact, "eventId"), false)
	if _, err = cs.SubmitV2(ctx, auth.Actor, encode(factAuth), ""); err != nil {
		t.Fatalf("case fact: %v", err)
	}
	f.meta["caseId"] = rootID
	f.meta["source"] = Object{"kind": "contribution-summary", "source": Object{"kind": "case-event", "id": fact["eventId"], "eventVersion": 1, "payloadHash": identity.Digest([]byte(txt(factAuth, "payloadJson")))}, "fields": []any{"eventType", "actorId", "interventionTypes"}}
	result := Object{"schemaVersion": 2, "eventId": uuid.NewString(), "caseId": rootID, "expectedVersion": 2, "actorId": auth.Actor.SubjectID, "kind": "result-recorded", "origin": Object{"kind": "intervention", "id": fact["eventId"], "version": 1}, "scopeVersion": 1, "deliverableRefs": []any{}, "reportedOutcome": "partial", "summary": "Private report", "limitations": "Only observed synthetic CI", "supersedes": nil}
	if _, err = cs.SubmitV2(ctx, auth.Actor, encode(f.authorize(t, result, "case.teaser.publish", txt(result, "eventId"), false)), ""); err != nil {
		t.Fatalf("case result: %v", err)
	}
	var ciTemplate struct {
		Fixture Object `json:"fixture"`
	}
	raw, err = os.ReadFile("../civ2/testdata/setup.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &ciTemplate); err != nil {
		t.Fatal(err)
	}
	ev := obj(ciTemplate.Fixture["evidence"])
	ev["id"] = uuid.NewString()
	ev["operationId"] = uuid.NewString()
	ev["caseId"] = rootID
	ev["reportedBy"] = auth.Actor.SubjectID
	ev["synthetic"] = true
	evAuth := f.authorize(t, ev, "evidence.submit", txt(ev, "operationId"), false)
	if _, err = rs.Submit(ctx, auth.Actor, encode(evAuth), ""); err != nil {
		t.Fatalf("evidence: %v", err)
	}
	req := obj(ciTemplate.Fixture["first"])
	req["id"] = uuid.NewString()
	req["caseId"] = rootID
	req["evidenceRef"] = Object{"id": ev["id"], "version": 1}
	req["resultRef"] = Object{"id": result["eventId"], "version": 1}
	pins := map[string]deviceauth.Pin{"go-fixture": {PublicKeyPEM: auth.Materials.HubPublic, NotBefore: 1999999999, NotAfter: 2000200000}}
	signer := &deviceauth.SessionKeyring{Endpoint: endpoint, KID: "go-fixture", Key: key, Pins: func() map[string]deviceauth.Pin { return pins }}
	ci := &civ2.Service{Pool: api, Endpoint: endpoint, Devices: devices, Records: rs, Signer: signer, Now: now}
	if _, err = ci.Submit(ctx, auth.Actor, encode(f.authorize(t, req, "ci.observe", "", false)), ""); err != nil {
		t.Fatalf("CI request: %v", err)
	}
	wc := owner.Config()
	wc.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, err := pgxpool.NewWithConfig(ctx, wc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(worker.Close)
	wci := &civ2.Service{Pool: worker, Endpoint: endpoint, Devices: devices, Records: rs, Now: now, ConsentReader: devices.RequireWorkerConsentWithin}
	wci.SourceReader = wci.WorkerSourceReader
	var job string
	if err = owner.QueryRow(ctx, `SELECT id::text FROM jobs WHERE deduplication_key=$1`, "ci-v2:"+txt(req, "id")).Scan(&job); err != nil {
		t.Fatal(err)
	}
	runJSON := txt(ciTemplate.Fixture, "runJson")
	out, err := wci.ProcessJob(ctx, job, func(ctx context.Context, ref Object, at int64) (Object, error) {
		var run Object
		if e := json.Unmarshal([]byte(runJSON), &run); e != nil {
			return nil, e
		}
		return evidence.InspectGithubRun(ref, run, at)
	})
	if err != nil || out.Result["state"] != "observed" {
		t.Fatalf("CI observation: %v %v", out, err)
	}
	preview, err := ci.Preview(ctx, auth.Actor, encode(Object{"id": uuid.NewString(), "requestId": req["id"]}))
	if err != nil {
		t.Fatalf("proof preview: %v", err)
	}
	var proofPayload Object
	if err = json.Unmarshal([]byte(txt(preview, "payloadJson")), &proofPayload); err != nil {
		t.Fatal(err)
	}
	published, err := ci.Publish(ctx, auth.Actor, encode(f.authorizeRaw(t, proofPayload, []byte(txt(preview, "payloadJson")), "proof.publish", "", true)), "")
	if err != nil {
		t.Fatalf("proof publish: %v", err)
	}
	var hash string
	if err = owner.QueryRow(ctx, `SELECT payload_hash FROM ci_proofs_v2 WHERE id=$1`, published["proofId"]).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	f.meta["proof"] = Object{"source": Object{"kind": "ci-proof-v2", "id": published["proofId"], "payloadHash": hash}, "published": published, "evidenceAuth": evAuth}
	return f
}

func TestGoPeerFixtureCurrentAuthorityAndProof(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	peer := newGoPeerFixture(t, owner, "https://b.example.invalid", true)
	if obj(peer.meta["proof"])["published"] == nil || peer.meta["source"] == nil {
		t.Fatal("missing authorized peer sources")
	}
}

func verifyCurrentSDK(t *testing.T, outer, proof string, meta Object) {
	t.Helper()
	root, err := filepath.Abs("../../..")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("node", filepath.Join(root, "go/internal/hubs/testdata/current-sdk-verify.mjs"))
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(encode(Object{"outer": outer, "proof": proof, "endpoint": meta["endpoint"], "pin": meta["pin"]}))
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if _, err = cmd.Output(); err != nil {
		t.Fatalf("current SDK peer/proof verify: %v %s", err, stderr.String())
	}
}
