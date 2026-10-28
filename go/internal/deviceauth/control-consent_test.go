package deviceauth

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestControlConsentAndRetainedReceiptInterop(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	dir := t.TempDir()
	var origin string
	run := func(mode string) []byte {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go/device-auth-interop.mjs"), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir, "GALAXY_GO_TEST_DEVICE_ORIGIN="+origin, "GALAXY_GO_TEST_SKIP_BOOTSTRAP=true")
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original JS %s: %v %s", mode, e, out)
		}
		return out
	}
	_ = run("setup")
	var state struct {
		DeviceID, PublicKeyPEM, OwnerPrivate, InstallationID string
		Genesis                                              struct {
			ID           string
			GenesisProof json.RawMessage
		}
	}
	raw, e := os.ReadFile(filepath.Join(dir, "fixture.json"))
	if e != nil || json.Unmarshal(raw, &state) != nil {
		t.Fatal("fixture state unavailable")
	}
	owner, e := identity.PrivatePEM([]byte(state.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	config := pool.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	api, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer api.Close()
	now := int64(2000000000)
	service, e := Load(ctx, api, Configuration{Endpoint: "https://device.example.invalid", SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(Handler{Service: service})
	defer server.Close()
	origin = server.URL
	call := func(method, path string, input any, bearer string) (int, map[string]any) {
		t.Helper()
		b, _ := json.Marshal(input)
		r, _ := http.NewRequest(method, origin+path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			r.Header.Set("Authorization", "Bearer "+bearer)
		}
		res, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		body, e := io.ReadAll(res.Body)
		if e != nil {
			t.Fatal(e)
		}
		var result map[string]any
		if e = json.Unmarshal(body, &result); e != nil {
			t.Fatalf("HTTP %s: %d %s", path, res.StatusCode, body)
		}
		return res.StatusCode, result
	}
	sign := func(key ed25519.PrivateKey, payload, kind string) string {
		t.Helper()
		signature, e := identity.SignIdentityPayload(key, payload, kind)
		if e != nil {
			t.Fatal(e)
		}
		return signature
	}
	controlSign := func(key ed25519.PrivateKey, payload string) string {
		return sign(key, payload, "galaxy-identity-control-v2+jws")
	}
	bootstrap := ControlRequest{Version: 2, OperationID: uuid.NewString(), SubjectID: state.Genesis.ID, Kind: "bootstrap", SignerKeyID: identity.Digest([]byte(state.PublicKeyPEM)), GenesisProof: state.Genesis.GenesisProof, NewDevice: &ControlDevice{state.DeviceID, state.PublicKeyPEM, []string{"manage-identity", "binding", "history", "consent"}}}
	code, issued := call("POST", "/v2/identity/control/challenges", bootstrap, "")
	if code != 200 {
		t.Fatalf("bootstrap challenge: %d %v", code, issued)
	}
	_, same := call("POST", "/v2/identity/control/challenges", bootstrap, "")
	if same["challenge"] != issued["challenge"] {
		t.Fatal("challenge replay replaced original operation")
	}
	sig := controlSign(owner, issued["challenge"].(string))
	commit := ControlCommit{bootstrap.OperationID, sig, &sig}
	code, receipt := call("POST", "/v2/identity/control/commit", commit, "")
	if code != 200 || receipt["epoch"] != float64(1) {
		t.Fatalf("bootstrap commit: %d %v", code, receipt)
	}
	code, replayed := call("POST", "/v2/identity/control/commit", commit, "")
	if code != 200 || replayed["chainHead"] != receipt["chainHead"] {
		t.Fatal("original control receipt not retained")
	}
	_ = run("client-consent")
	tokenRaw, e := os.ReadFile(filepath.Join(dir, "credential.txt"))
	if e != nil {
		t.Fatal(e)
	}
	token := string(tokenRaw)
	actor, e := service.Authenticate(ctx, token, "consent")
	if e != nil {
		t.Fatal(e)
	}
	payload := `{"title":"controlled forum intent"}`
	intent := ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: actor.SubjectID, BindingID: actor.BindingID, Endpoint: service.Endpoint, ObjectID: "controlled-forum-post", Action: "forum.post.publish", Purpose: "public-profile", Recipient: service.Endpoint, Fields: []string{"title"}, Visibility: "Public", Viewers: []string{}, PayloadHash: identity.Digest([]byte(payload)), PolicyVersion: "0.1", IssuedAt: now, ExpiresAt: now + 600}
	intentRaw, _ := json.Marshal(intent)
	signed := sign(owner, string(intentRaw), "galaxy-consent+jws")
	if _, e = service.CaptureConsent(ctx, actor, signed); fault.Code(e) != "forum_atomic_write_required" {
		t.Fatalf("forum signature escaped atomic write: %v", e)
	}
	sentinel := errors.New("rollback controlled publication")
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (bool, error) {
		_, e := service.CaptureConsentWithin(ctx, tx, actor, signed, ConsentOptions{Forum: true})
		if e != nil {
			return false, e
		}
		return false, sentinel
	})
	if !errors.Is(e, sentinel) {
		t.Fatal(e)
	}
	var n int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM consents WHERE id=$1", intent.ID).Scan(&n); e != nil || n != 0 {
		t.Fatal("failed publication left unused grant")
	}
	requirement := ConsentRequirement{intent.ID, actor.SubjectID, intent.Action, intent.ObjectID, service.Endpoint, payload}
	capture, e := postgres.InTx(ctx, api, func(tx pgx.Tx) (ConsentCapture, error) {
		c, e := service.CaptureConsentWithin(ctx, tx, actor, signed, ConsentOptions{Forum: true})
		if e != nil {
			return c, e
		}
		_, e = service.RequireConsentWithin(ctx, tx, requirement)
		return c, e
	})
	if e != nil || capture.Authorization.ChainHead == nil || capture.Authorization.CallerBindingID != actor.BindingID || !contains(capture.Authorization.CredentialScopes, "consent") {
		t.Fatalf("atomic consent metadata: %+v %v", capture, e)
	}
	locator, _ := json.Marshal(map[string]any{"id": intent.ID, "action": intent.Action, "objectId": intent.ObjectID, "payloadJson": payload})
	if e = os.WriteFile(filepath.Join(dir, "consent-locator.json"), locator, 0600); e != nil {
		t.Fatal(e)
	}
	var original struct {
		OriginalSignature      bool
		PayloadText, ChainHead string
	}
	if e = json.Unmarshal(run("consent-read"), &original); e != nil || !original.OriginalSignature || original.PayloadText != string(intentRaw) || original.ChainHead != *capture.Authorization.ChainHead {
		t.Fatalf("original JS consent evidence mismatch %+v %v", original, e)
	}
	var originalGrant ConsentRequirement
	if e = json.Unmarshal(run("js-consent-create"), &originalGrant); e != nil {
		t.Fatal(e)
	}
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (ConsentIntent, error) { return service.RequireConsentWithin(ctx, tx, originalGrant) })
	if e != nil {
		t.Fatalf("Go did not read original JS signed grant: %v", e)
	}
	requirement.PayloadJSON = `{ "title":"controlled forum intent"}`
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (ConsentIntent, error) { return service.RequireConsentWithin(ctx, tx, requirement) })
	if fault.Code(e) != "consent_required" {
		t.Fatal("reserialized payload accepted")
	}
	requirement.PayloadJSON = payload
	// Revocation cannot overtake a protected mutation holding the original grant.
	tx, e := api.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = service.RequireConsentWithin(ctx, tx, requirement); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { _, e := service.RevokeConsent(ctx, actor, intent.ID, nil); done <- e }()
	select {
	case e := <-done:
		t.Fatalf("revocation crossed grant lock: %v", e)
	case <-time.After(100 * time.Millisecond):
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	_, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (ConsentIntent, error) { return service.RequireConsentWithin(ctx, tx, requirement) })
	if fault.Code(e) != "consent_required" {
		t.Fatal("revoked grant retained")
	}
	// Closed metadata family: no ordinary credential needed and no body returned.
	snapshot, version := uuid.NewString(), uuid.NewString()
	requestHash := strings.Repeat("a", 64)
	at := time.Unix(now, 0)
	if _, e = pool.Exec(ctx, "INSERT INTO choice_snapshot_heads(subject_id,snapshot_id,created_at,updated_at) VALUES($1,$2,$3,$3)", actor.SubjectID, snapshot, at); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `INSERT INTO choice_snapshot_versions(subject_id,snapshot_id,version_id,base_revision,revision,request_hash,state,content,dependencies,created_at,expires_at) VALUES($1,$2,$3,0,1,$4,'expired','{"privateBody":"must never appear"}','[]',$5,$6)`, actor.SubjectID, snapshot, version, requestHash, at, at.Add(-time.Second)); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, "UPDATE bindings SET revoked_at=$2 WHERE id=$1", actor.BindingID, at); e != nil {
		t.Fatal(e)
	}
	operation := ReceiptOperation{"choice-snapshot", snapshot, version, requestHash}
	writeLocator := func(op ReceiptOperation) {
		b, _ := json.Marshal(op)
		if e = os.WriteFile(filepath.Join(dir, "receipt-locator.json"), b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	writeLocator(operation)
	var result struct {
		Result map[string]any
		Calls  int
	}
	out := run("receipt-client")
	if e = json.Unmarshal(out, &result); e != nil || result.Calls != 2 || result.Result["state"] != "acknowledged" || strings.Contains(string(out), "must never appear") || result.Result["contentReturned"] != false {
		t.Fatalf("retained receipt: %s %v", out, e)
	}
	operation.RequestHash = strings.Repeat("b", 64)
	writeLocator(operation)
	if e = json.Unmarshal(run("receipt-client"), &result); e != nil || result.Result["state"] != "conflict" {
		t.Fatal("receipt mismatch not distinguished")
	}
	operation.VersionID = uuid.NewString()
	writeLocator(operation)
	if e = json.Unmarshal(run("receipt-client"), &result); e != nil || result.Result["state"] != "absent" {
		t.Fatal("receipt absence not retained")
	}
	service.ReceiptStatusDeadline = func() (int64, error) { return now, nil }
	if _, e = service.ReceiptChallenge(ctx, ReceiptChallengeInput{actor.SubjectID, ReceiptControl{actor.DeviceID, *actor.KeyID, 1}, operation, strings.Repeat("A", 43)}); fault.Code(e) != "service_retired" {
		t.Fatal("receipt service deadline ignored")
	}
	service.ReceiptStatusDeadline = nil
	// Current control mutations and recovery retain one signed append-only chain.
	nextRequest := func(kind string) ControlRequest {
		state, e := service.ControlPublicState(ctx, actor.SubjectID)
		if e != nil {
			t.Fatal(e)
		}
		head := state["chainHead"].(*string)
		return ControlRequest{Version: 2, OperationID: uuid.NewString(), SubjectID: actor.SubjectID, Kind: kind, ExpectedEpoch: state["epoch"].(int64), PreviousEventHash: head, SignerKeyID: identity.Digest([]byte(statePublic(owner)))}
	}
	perform := func(r ControlRequest, key ed25519.PrivateKey, newKey ed25519.PrivateKey) (map[string]any, ControlCommit) {
		t.Helper()
		b, _ := json.Marshal(r)
		issued, e := service.ControlChallenge(ctx, b)
		if e != nil {
			t.Fatal(e)
		}
		sig := controlSign(key, issued["challenge"].(string))
		c := ControlCommit{r.OperationID, sig, nil}
		if newKey != nil {
			p := controlSign(newKey, issued["challenge"].(string))
			c.NewDeviceProof = &p
		}
		result, e := service.ControlCommit(ctx, c)
		if e != nil {
			t.Fatalf("control %s: %v", r.Kind, e)
		}
		return result, c
	}
	_, joining, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	joiningPublic := statePublic(joining)
	deviceID := uuid.NewString()
	r := nextRequest("authorize-device")
	r.NewDevice = &ControlDevice{deviceID, joiningPublic, []string{"binding", "consent"}}
	_, joiningCommit := perform(r, owner, joining)
	approvalOnly := joiningCommit
	approvalOnly.NewDeviceProof = nil
	if _, e = service.ControlStatus(ctx, approvalOnly); e != nil {
		t.Fatal(e)
	}
	pending := nextRequest("revoke-device")
	pending.DeviceID = deviceID
	pendingRaw, _ := json.Marshal(pending)
	ch, e := service.ControlChallenge(ctx, pendingRaw)
	if e != nil {
		t.Fatal(e)
	}
	cancelSig := controlSign(owner, ch["challenge"].(string))
	cancel := ControlCommit{pending.OperationID, cancelSig, nil}
	if _, e = service.ControlCancel(ctx, cancel); e != nil {
		t.Fatal(e)
	}
	if _, e = service.ControlCommit(ctx, cancel); fault.Code(e) != "identity_operation_canceled" {
		t.Fatal("cancelled operation committed")
	}
	r = nextRequest("revoke-device")
	r.DeviceID = deviceID
	_, _ = perform(r, owner, nil)
	r = nextRequest("revoke-device")
	r.DeviceID = state.DeviceID
	b, _ := json.Marshal(r)
	ch, e = service.ControlChallenge(ctx, b)
	if e != nil {
		t.Fatal(e)
	}
	lastSig := controlSign(owner, ch["challenge"].(string))
	if _, e = service.ControlCommit(ctx, ControlCommit{r.OperationID, lastSig, nil}); fault.Code(e) != "identity_last_controller" {
		t.Fatalf("last controller revoked: %v", e)
	}
	_, recoveryKey, _ := ed25519.GenerateKey(rand.Reader)
	recoveryPublic := statePublic(recoveryKey)
	generation := int64(0)
	yes := true
	r = nextRequest("set-recovery")
	r.RecoveryGeneration = &generation
	r.NextRecoveryPublicKey = &recoveryPublic
	r.SaveDeclaration = &yes
	_, _ = perform(r, owner, nil)
	generation = 1
	r = nextRequest("declare-recovery-saved")
	r.RecoveryGeneration = &generation
	r.SaveDeclaration = &yes
	_, _ = perform(r, owner, nil)
	_, restored, _ := ed25519.GenerateKey(rand.Reader)
	_, nextRecovery, _ := ed25519.GenerateKey(rand.Reader)
	nextRecoveryPublic := statePublic(nextRecovery)
	r = nextRequest("recover")
	r.SignerKeyID = identity.Digest([]byte(recoveryPublic))
	r.RecoveryGeneration = &generation
	r.NewDevice = &ControlDevice{uuid.NewString(), statePublic(restored), []string{"manage-identity", "binding", "history", "consent"}}
	r.NextRecoveryPublicKey = &nextRecoveryPublic
	recovered, recoveryCommit := perform(r, recoveryKey, restored)
	if recovered["epoch"] != int64(2) || recovered["consumedRecoveryGeneration"] != int64(1) {
		t.Fatalf("recovery receipt %+v", recovered)
	}
	if _, e = service.ControlStatus(ctx, recoveryCommit); e != nil {
		t.Fatal(e)
	}
	if _, e = service.ControlStatus(ctx, approvalOnly); fault.Code(e) != "identity_control_stale" {
		t.Fatal("old approval retained current management authority")
	}
	if _, e = service.ControlCommit(ctx, commit); e != nil {
		t.Fatal("exact original bootstrap proof cannot recover original receipt")
	}
	var chain struct {
		Epoch, Sequence int
		ChainHead       string
	}
	if e = json.Unmarshal(run("chain"), &chain); e != nil || chain.Epoch != 2 || chain.Sequence != 6 {
		t.Fatalf("original JS control-chain verification %+v %v", chain, e)
	}
}
func statePublic(private ed25519.PrivateKey) string {
	value, _ := identity.PublicPEM(private.Public().(ed25519.PublicKey))
	return value
}
