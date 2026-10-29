package deviceauth

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOriginalNativeDeviceHandshakeAndRevocation(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	dir := t.TempDir()
	var origin string
	run := func(mode string) []byte {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/device-client-fixture.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir, "GALAXY_GO_TEST_DEVICE_ORIGIN="+origin)
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original JS %s: %v %s", mode, e, out)
		}
		return out
	}
	fixture := prepareControlFixture(t, pool, dir, true)
	metadata := struct{ SubjectID, DeviceID, PublicKeyPEM, HubPublic string }{fixture.Genesis.ID, fixture.DeviceID, fixture.PublicKeyPEM, fixture.HubPublic}
	keyBytes, e := os.ReadFile(filepath.Join(dir, "hub-private.pem"))
	if e != nil {
		t.Fatal(e)
	}
	private, e := identity.PrivatePEM(keyBytes)
	if e != nil {
		t.Fatal(e)
	}
	now := int64(2000000000)
	pin := Pin{PublicKeyPEM: metadata.HubPublic, NotBefore: now - 100, NotAfter: now + 100000}
	keyring := &SessionKeyring{Endpoint: "https://device.example.invalid", KID: "fixture", Key: private, Pins: func() map[string]Pin { return map[string]Pin{"fixture": pin} }}
	apiConfig := pool.Config()
	apiConfig.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	apiPool, e := pgxpool.NewWithConfig(ctx, apiConfig)
	if e != nil {
		t.Fatal(e)
	}
	defer apiPool.Close()
	configuration := Configuration{Endpoint: keyring.Endpoint, SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(now, 0) }}
	service, e := Load(ctx, apiPool, configuration)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = Load(ctx, apiPool, configuration); e != nil {
		t.Fatalf("same trust state reload: %v", e)
	}
	// Repeated loading must preserve the established Go trust sequence.
	if service.Signer.(*SessionKeyring).TrustSequence() != 1 {
		t.Fatal("trust sequence changed")
	}
	server := httptest.NewServer(Handler{Service: service})
	defer server.Close()
	origin = server.URL
	var connected struct {
		SubjectID, BindingID, DeviceID string
		ControlEpoch                   int
		Paths                          []string
	}
	if e = json.Unmarshal(run("client"), &connected); e != nil {
		t.Fatal(e)
	}
	if connected.SubjectID != metadata.SubjectID || connected.DeviceID != metadata.DeviceID || connected.ControlEpoch != 1 || len(connected.Paths) != 4 {
		t.Fatalf("Native connection mismatch %+v", connected)
	}
	tokenBytes, e := os.ReadFile(filepath.Join(dir, "credential.txt"))
	if e != nil {
		t.Fatal(e)
	}
	token := string(tokenBytes)
	actor, e := service.Authenticate(ctx, token, "history")
	if e != nil || actor.SubjectID != metadata.SubjectID || actor.ControlEpoch != 1 || actor.DeviceID == nil || *actor.DeviceID != metadata.DeviceID {
		t.Fatalf("Go did not read original Native credential: %+v %v", actor, e)
	}
	if _, e = service.Authenticate(ctx, token, "data-delete"); fault.Code(e) != "access_denied" {
		t.Fatalf("scope escalated %v", e)
	}
	if _, e = service.Authenticate(ctx, token+"=", "history"); fault.Code(e) != "access_denied" {
		t.Fatal("noncanonical bearer accepted")
	}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		e := service.AuthorizeWithin(ctx, tx, actor, "history")
		return e == nil, e
	})
	if e != nil {
		t.Fatal(e)
	}
	var count int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE action='session.create' AND binding_id=$1", actor.BindingID).Scan(&count); e != nil || count != 1 {
		t.Fatalf("auth audit=%d %v", count, e)
	}
	// Additional exact challenge: concurrent activation has one ledger write and
	// replay returns the committed original session rather than issuing another.
	rawState, e := os.ReadFile(filepath.Join(dir, "fixture.json"))
	if e != nil {
		t.Fatal(e)
	}
	var state struct {
		OwnerPrivate   string
		InstallationID string
		Genesis        struct {
			ID           string
			GenesisProof json.RawMessage
		}
	}
	if json.Unmarshal(rawState, &state) != nil {
		t.Fatal("fixture key metadata invalid")
	}
	deviceKey, e := identity.PrivatePEM([]byte(state.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	input := BindingInput{SubjectID: state.Genesis.ID, GenesisProof: state.Genesis.GenesisProof, InstallationID: state.InstallationID, Scopes: []string{"binding", "history"}, Control: &BindingControl{DeviceID: metadata.DeviceID, KeyID: identity.Digest([]byte(metadata.PublicKeyPEM)), Epoch: 1}}
	bad := input
	bad.SubjectID = input.SubjectID[:31] + "Z"
	if bad.SubjectID == input.SubjectID {
		bad.SubjectID = input.SubjectID[:31] + "Y"
	}
	if _, e = service.BindingChallenge(ctx, bad, true); fault.Code(e) != "identity_or_scope_invalid" {
		t.Fatal("GUID accepted without matching genesis")
	}
	challenge, e := service.BindingChallenge(ctx, input, true)
	if e != nil {
		t.Fatal(e)
	}
	bindingSignature, e := identity.SignIdentityPayload(deviceKey, challenge["challenge"], "galaxy-binding-response+jws")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = service.Bind(ctx, BindInput{challenge["challenge"], bindingSignature, strings.Repeat("B", 43)}, nil); fault.Code(e) != "binding_proof_invalid" {
		t.Fatal("wrong clientSession accepted")
	}
	service.BindingGate = func(context.Context, SQLReader, string) error { return fault.New("service_enrollment_stopped", 410) }
	if _, e = service.Bind(ctx, BindInput{challenge["challenge"], bindingSignature, challenge["clientSession"]}, nil); fault.Code(e) != "service_enrollment_stopped" {
		t.Fatal("binding lifecycle gate bypassed")
	}
	service.BindingGate = nil
	var bindWG sync.WaitGroup
	results := make(chan BindingResult, 4)
	for range 4 {
		bindWG.Go(func() {
			r, e := service.Bind(ctx, BindInput{challenge["challenge"], bindingSignature, challenge["clientSession"]}, nil)
			if e != nil {
				t.Error(e)
			} else {
				results <- r
			}
		})
	}
	bindWG.Wait()
	close(results)
	var first BindingResult
	for r := range results {
		if first.BindingID == "" {
			first = r
		} else if r != first {
			t.Fatal("unknown binding result did not recover original receipt")
		}
	}
	if first.BindingID == "" || first.Receipt == "" {
		t.Fatal("binding result missing")
	}
	var bindingCount int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM bindings WHERE challenge_id=$1", challenge["challengeId"]).Scan(&bindingCount); e != nil || bindingCount != 1 {
		t.Fatal("concurrent binding duplicated original operation")
	}
	// The legacy route remains an existing compatibility path for a verified
	// genesis, while v2 requires the explicit current device/key/epoch triple.
	legacy := input
	legacy.Control = nil
	if _, e = service.BindingChallenge(ctx, legacy, true); fault.Code(e) != "invalid_request" {
		t.Fatal("v2 accepted absent control")
	}
	if _, e = service.BindingChallenge(ctx, legacy, false); e != nil {
		t.Fatal(e)
	}
	secondToken := strings.Repeat("A", 43)
	preview, e := service.Challenge(ctx, ChallengeInput{actor.BindingID, identity.Digest([]byte(secondToken))})
	if e != nil {
		t.Fatal(e)
	}
	signature, e := identity.SignIdentityPayload(deviceKey, preview["challenge"], "galaxy-session-response+jws")
	if e != nil {
		t.Fatal(e)
	}
	_, wrongKey, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	wrong, _ := identity.SignIdentityPayload(wrongKey, preview["challenge"], "galaxy-session-response+jws")
	if _, e = service.Activate(ctx, ActivateInput{preview["challenge"], wrong}, nil); fault.Code(e) != "access_denied" {
		t.Fatal("wrong device signature accepted")
	}
	var wg sync.WaitGroup
	var ok atomic.Int32
	for range 6 {
		wg.Go(func() {
			if _, e := service.Activate(ctx, ActivateInput{preview["challenge"], signature}, nil); e != nil {
				t.Error(e)
			} else {
				ok.Add(1)
			}
		})
	}
	wg.Wait()
	if ok.Load() != 6 {
		t.Fatalf("original callback recovery=%d", ok.Load())
	}
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM access_credentials WHERE token_hash=$1", identity.Digest([]byte(secondToken))).Scan(&count); e != nil || count != 1 {
		t.Fatal("activation duplicated credential")
	}
	if _, e = service.Challenge(ctx, ChallengeInput{actor.BindingID, identity.Digest([]byte(secondToken))}); fault.Code(e) != "credential_conflict" {
		t.Fatalf("credential conflict %v", e)
	}
	if _, e = service.Authenticate(ctx, secondToken, "history"); e != nil {
		t.Fatal(e)
	}
	// Reduce this device's live scope: current credentials lose authority without
	// changing their bytes, ID, binding or stored session scopes.
	if _, e = pool.Exec(ctx, "UPDATE device_authorizations SET scopes='[\"binding\"]' WHERE device_id=$1", metadata.DeviceID); e != nil {
		t.Fatal(e)
	}
	if _, e = service.Authenticate(ctx, token, "history"); fault.Code(e) != "access_denied" {
		t.Fatal("removed scope retained")
	}
	if _, e = service.Authenticate(ctx, token, "binding"); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE device_authorizations SET scopes='[\"binding\",\"history\",\"manage-identity\"]' WHERE device_id=$1", metadata.DeviceID); e != nil {
		t.Fatal(e)
	}
	// Epoch advancement invalidates the original device, even while binding and
	// credential expiry timestamps still permit use.
	if _, e = pool.Exec(ctx, "UPDATE subject_control_heads SET epoch=epoch+1 WHERE subject_id=$1", metadata.SubjectID); e != nil {
		t.Fatal(e)
	}
	if _, e = service.Authenticate(ctx, token, "history"); fault.Code(e) != "access_denied" {
		t.Fatal("stale epoch authenticated")
	}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		e := service.AuthorizeWithin(ctx, tx, actor, "history")
		return e == nil, e
	})
	if fault.Code(e) != "access_denied" {
		t.Fatal("stale transaction authority retained")
	}
	if _, e = pool.Exec(ctx, "UPDATE subject_control_heads SET epoch=1 WHERE subject_id=$1", metadata.SubjectID); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE device_authorizations SET status='revoked' WHERE device_id=$1", metadata.DeviceID); e != nil {
		t.Fatal(e)
	}
	if _, e = service.Activate(ctx, ActivateInput{preview["challenge"], signature}, nil); fault.Code(e) != "access_denied" {
		t.Fatal("revoked device replay activated")
	}
	if _, e = pool.Exec(ctx, "UPDATE device_authorizations SET status='active' WHERE device_id=$1", metadata.DeviceID); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE bindings SET revoked_at=$2 WHERE id=$1", actor.BindingID, time.Unix(now, 0)); e != nil {
		t.Fatal(e)
	}
	if _, e = service.Authenticate(ctx, token, "history"); fault.Code(e) != "access_denied" {
		t.Fatal("revoked binding authenticated")
	}
	// Public trust state never permits a lower sequence to replace an accepted one.
	statePath := filepath.Join(configuration.TrustDirectory, identity.Digest([]byte(configuration.Endpoint))+".json")
	retained, e := os.ReadFile(statePath)
	if e != nil {
		t.Fatal(e)
	}
	var saved map[string]any
	_ = json.Unmarshal(retained, &saved)
	saved["sequence"] = float64(2)
	badState, _ := json.Marshal(saved)
	if e = os.WriteFile(statePath, badState, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = Load(ctx, apiPool, configuration); e == nil {
		t.Fatal("trust sequence rollback accepted")
	}
	if e = os.WriteFile(statePath, retained, 0600); e != nil {
		t.Fatal(e)
	}
	for _, caseName := range []string{"key-reuse", "revoked-resurrection"} {
		var changed trustState
		if e = json.Unmarshal(retained, &changed); e != nil {
			t.Fatal(e)
		}
		if caseName == "key-reuse" {
			changed.History[0].Fingerprint = strings.Repeat("f", 64)
		} else {
			changed.History[0].Revoked = true
		}
		raw, _ := json.Marshal(changed)
		if e = os.WriteFile(statePath, raw, 0600); e != nil {
			t.Fatal(e)
		}
		if _, e = Load(ctx, apiPool, configuration); e == nil {
			t.Fatalf("trust %s accepted", caseName)
		}
	}
	if e = os.WriteFile(statePath, retained, 0600); e != nil {
		t.Fatal(e)
	}
	// Pin revocation and exact type validation happen before ledger consumption.
	pin.Revoked = true
	if _, e = keyring.Verify(ctx, preview["challenge"], now); fault.Code(e) != "access_denied" {
		t.Fatal("revoked pin accepted")
	}
	if _, e = pool.Exec(ctx, "UPDATE bindings SET revoked_at=NULL WHERE id=$1", actor.BindingID); e != nil {
		t.Fatal(e)
	}
	now += 601
	if _, e = service.Authenticate(ctx, token, "binding"); fault.Code(e) != "access_denied" {
		t.Fatal("expired session authenticated")
	}
}
