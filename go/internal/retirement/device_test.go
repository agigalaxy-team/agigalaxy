package retirement

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestRetirementActualDeviceGatesAndReceiptDeadline(t *testing.T) {
	ownerPool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	dir := t.TempDir()
	now := int64(2000000000)
	var origin string
	node := func(script, mode string) []byte {
		t.Helper()
		cmd := exec.Command("node", filepath.Join(root, "scripts/go", script), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir, "GALAXY_GO_TEST_DEVICE_ORIGIN="+origin, "GALAXY_GO_TEST_SKIP_BOOTSTRAP=true", "GALAXY_GO_TEST_RETIREMENT_DIR="+dir)
		out, e := cmd.CombinedOutput()
		if e != nil {
			t.Fatalf("original fixture %s %s: %v %s", script, mode, e, out)
		}
		return out
	}
	_ = node("device-auth-interop.mjs", "setup")
	var state struct {
		DeviceID, PublicKeyPEM, OwnerPrivate, InstallationID string
		Genesis                                              struct {
			ID           string
			GenesisProof json.RawMessage
		}
	}
	raw, e := os.ReadFile(filepath.Join(dir, "fixture.json"))
	if e != nil || json.Unmarshal(raw, &state) != nil {
		t.Fatal("isolated identity state unavailable")
	}
	private, e := identity.PrivatePEM([]byte(state.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	config := ownerPool.Config()
	config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	service, e := deviceauth.Load(ctx, pool, deviceauth.Configuration{Endpoint: samplePolicy().Endpoint, SigningKeyFile: filepath.Join(dir, "hub-private.pem"), SigningKeyID: "fixture", RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: func() time.Time { return time.Unix(now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	policy := samplePolicy()
	controller, e := New(&policy, Options{Endpoint: policy.Endpoint, Now: func() time.Time { return time.Unix(now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	controller.BindDevice(service)
	bootstrap := deviceauth.ControlRequest{Version: 2, OperationID: uuid.NewString(), SubjectID: state.Genesis.ID, Kind: "bootstrap", SignerKeyID: identity.Digest([]byte(state.PublicKeyPEM)), GenesisProof: state.Genesis.GenesisProof, NewDevice: &deviceauth.ControlDevice{DeviceID: state.DeviceID, PublicKeyPEM: state.PublicKeyPEM, Scopes: []string{"manage-identity", "binding", "history", "consent"}}}
	b, _ := json.Marshal(bootstrap)
	ch, e := service.ControlChallenge(ctx, b)
	if e != nil {
		t.Fatal(e)
	}
	signature, e := identity.SignIdentityPayload(private, ch["challenge"].(string), "galaxy-identity-control-v2+jws")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = service.ControlCommit(ctx, deviceauth.ControlCommit{OperationID: bootstrap.OperationID, ControllerSignature: signature, NewDeviceProof: &signature}); e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(controller.Handler(deviceauth.Handler{Service: service, Next: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })}))
	defer server.Close()
	origin = server.URL
	_ = node("device-auth-interop.mjs", "client-consent")
	token, e := os.ReadFile(filepath.Join(dir, "credential.txt"))
	if e != nil {
		t.Fatal(e)
	}
	actor, e := service.Authenticate(ctx, string(token), "consent")
	if e != nil {
		t.Fatal(e)
	}
	// The shared account-link verification port is tied to this live tx authority.
	verification, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (deviceauth.ControlAuthorization, error) {
		return service.CurrentControlWithin(ctx, tx, actor, "binding")
	})
	if e != nil || verification.PublicKey != state.PublicKeyPEM || verification.KeyID != identity.Digest([]byte(state.PublicKeyPEM)) || verification.DeviceID == nil || *verification.DeviceID != state.DeviceID || verification.Epoch != 1 || verification.ChainHead == nil {
		t.Fatalf("current public control mismatch %+v %v", verification, e)
	}
	var stranger struct {
		Genesis struct {
			ID           string
			GenesisProof json.RawMessage
		}
		InstallationID string
	}
	if e = json.Unmarshal(node("retirement-interop.mjs", "stranger"), &stranger); e != nil {
		t.Fatal(e)
	}
	strangerKeyRaw, e := os.ReadFile(filepath.Join(dir, "stranger-private.pem"))
	if e != nil {
		t.Fatal(e)
	}
	strangerKey, e := identity.PrivatePEM(strangerKeyRaw)
	if e != nil {
		t.Fatal(e)
	}
	newInput := deviceauth.BindingInput{SubjectID: stranger.Genesis.ID, GenesisProof: stranger.Genesis.GenesisProof, InstallationID: stranger.InstallationID, Scopes: []string{"binding"}}
	pending, e := service.BindingChallenge(ctx, newInput, false)
	if e != nil {
		t.Fatal(e)
	}
	now = policy.StopWritesAt
	if _, e = service.BindingChallenge(ctx, newInput, false); fault.Code(e) != "service_enrollment_stopped" {
		t.Fatalf("new takeout enrollment: %v", e)
	}
	newSignature, _ := identity.SignIdentityPayload(strangerKey, pending["challenge"], "galaxy-binding-response+jws")
	if _, e = service.Bind(ctx, deviceauth.BindInput{Challenge: pending["challenge"], Signature: newSignature, ClientSession: pending["clientSession"]}, nil); fault.Code(e) != "service_enrollment_stopped" {
		t.Fatalf("pending enrollment crossed stop boundary: %v", e)
	}
	known := deviceauth.BindingInput{SubjectID: state.Genesis.ID, GenesisProof: state.Genesis.GenesisProof, InstallationID: state.InstallationID, Scopes: []string{"binding"}, Control: &deviceauth.BindingControl{DeviceID: state.DeviceID, KeyID: identity.Digest([]byte(state.PublicKeyPEM)), Epoch: 1}}
	renewal, e := service.BindingChallenge(ctx, known, true)
	if e != nil {
		t.Fatal(e)
	}
	responseSignature, _ := identity.SignIdentityPayload(private, renewal["challenge"], "galaxy-binding-response+jws")
	if _, e = service.Bind(ctx, deviceauth.BindInput{Challenge: renewal["challenge"], Signature: responseSignature, ClientSession: renewal["clientSession"]}, nil); e != nil {
		t.Fatalf("existing takeout rebind denied: %v", e)
	}
	payload := `{"title":"retirement-only denied grant"}`
	intent := deviceauth.ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: actor.SubjectID, BindingID: actor.BindingID, Endpoint: policy.Endpoint, ObjectID: "retirement-consent", Action: "history.query", Purpose: "operational", Recipient: policy.Endpoint, Fields: []string{"title"}, Visibility: "Private", Viewers: []string{actor.SubjectID}, PayloadHash: identity.Digest([]byte(payload)), PolicyVersion: "0.1", IssuedAt: now, ExpiresAt: now + 600}
	intentRaw, _ := json.Marshal(intent)
	consentSignature, _ := identity.SignIdentityPayload(private, string(intentRaw), "galaxy-consent+jws")
	if _, e = service.CaptureConsent(ctx, actor, consentSignature); fault.Code(e) != "service_writes_stopped" {
		t.Fatalf("takeout consent gate: %v", e)
	}
	request := func(method, path string, input any) (int, map[string]any) {
		t.Helper()
		b, _ := json.Marshal(input)
		r, _ := http.NewRequest(method, origin+path, bytes.NewReader(b))
		r.Header.Set("Content-Type", "application/json")
		res, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var result map[string]any
		_ = json.Unmarshal(raw, &result)
		return res.StatusCode, result
	}
	code, result := request("POST", "/v1/consents", map[string]any{})
	if code != 410 || result["error"] != "service_writes_stopped" {
		t.Fatalf("HTTP stop gate %d %+v", code, result)
	}
	code, result = request("GET", "/v1/service-status", nil)
	if code != 200 || result["phase"] != "takeout" || result["businessWritesAccepted"] != false || result["downloadsAccepted"] != true {
		t.Fatal("takeout state projection changed")
	}
	now = policy.StatusUntil - 1
	code, result = request("POST", "/v1/session-challenges", map[string]any{})
	if code != 410 || result["error"] != "service_retired" {
		t.Fatal("ordinary session restarted during status-only")
	}
	operation := deviceauth.ReceiptOperation{Kind: "choice-snapshot", SnapshotID: uuid.NewString(), VersionID: uuid.NewString(), RequestHash: strings.Repeat("d", 64)}
	receiptInput := deviceauth.ReceiptChallengeInput{SubjectID: actor.SubjectID, Control: deviceauth.ReceiptControl{DeviceID: actor.DeviceID, KeyID: verification.KeyID, Epoch: 1}, Operation: operation, ClientNonce: strings.Repeat("A", 43)}
	code, result = request("POST", "/v2/receipt-status/challenges", receiptInput)
	if code != 201 || result["expiresAt"] != float64(policy.StatusUntil) || result["ordinarySessionCreated"] != false {
		t.Fatalf("retained deadline: %d %+v", code, result)
	}
	proof := result["challenge"].(string)
	receiptSignature, _ := identity.SignIdentityPayload(private, proof, "galaxy-receipt-status-response+jws")
	code, result = request("POST", "/v2/receipt-status/query", deviceauth.ReceiptQueryInput{Challenge: proof, Signature: receiptSignature})
	if code != 200 || result["state"] != "absent" || result["currentAccessGranted"] != false || result["contentReturned"] != false {
		t.Fatalf("retained receipt: %d %+v", code, result)
	}
	now = policy.StatusUntil
	code, result = request("POST", "/v2/receipt-status/query", deviceauth.ReceiptQueryInput{Challenge: proof, Signature: receiptSignature})
	if code != 410 || result["error"] != "service_retired" {
		t.Fatal("statusUntil did not close original receipt endpoint")
	}
	if _, e = service.ReceiptChallenge(ctx, receiptInput); fault.Code(e) != "service_retired" {
		t.Fatal("direct receipt deadline bypassed")
	}
	code, result = request("GET", "/v1/service-status", nil)
	if code != 200 || result["phase"] != "closed" {
		t.Fatal("closed service metadata unavailable")
	}
	var subjects, grants int
	if e = ownerPool.QueryRow(ctx, "SELECT count(*) FROM subjects WHERE id=$1", stranger.Genesis.ID).Scan(&subjects); e != nil || subjects != 0 {
		t.Fatal("blocked enrollment persisted identity")
	}
	if e = ownerPool.QueryRow(ctx, "SELECT count(*) FROM consents WHERE id=$1", intent.ID).Scan(&grants); e != nil || grants != 0 {
		t.Fatal("stopped write persisted consent")
	}
}
