package native

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type connectionFixtureMetadata struct {
	Configuration Configuration    `json:"configuration"`
	Origin        string           `json:"origin"`
	Now           int64            `json:"now"`
	Operation     ReceiptOperation `json:"operation"`
}
type connectionTestTransport struct {
	origin        *url.URL
	mu            sync.Mutex
	paths         []string
	authorization []bool
	hook          func(*http.Response, *http.Request) (*http.Response, error)
}

func (t *connectionTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.mu.Lock()
	t.paths = append(t.paths, req.URL.Path)
	t.authorization = append(t.authorization, req.Header.Get("Authorization") != "")
	hook := t.hook
	t.mu.Unlock()
	copy := req.Clone(req.Context())
	u := *req.URL
	u.Scheme = t.origin.Scheme
	u.Host = t.origin.Host
	copy.URL = &u
	copy.Host = t.origin.Host
	response, e := http.DefaultTransport.RoundTrip(copy)
	if e != nil {
		return nil, e
	}
	if hook != nil {
		return hook(response, req)
	}
	return response, nil
}
func (t *connectionTestTransport) count() int { t.mu.Lock(); defer t.mu.Unlock(); return len(t.paths) }
func (t *connectionTestTransport) setHook(hook func(*http.Response, *http.Request) (*http.Response, error)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.hook = hook
}
func connectionServiceFixture(t *testing.T) (*Store, connectionFixtureMetadata, *connectionTestTransport) {
	t.Helper()
	pool, _ := testsupport.PostgreSQL(t)
	store, meta, transport, _ := connectionServiceFixtureWithPool(t, pool)
	return store, meta, transport
}
func connectionServiceFixtureWithPool(t *testing.T, pool *pgxpool.Pool) (*Store, connectionFixtureMetadata, *connectionTestTransport, deviceauthfixture.Fixture) {
	t.Helper()
	ctx := context.Background()
	dir := t.TempDir()
	prepared := deviceauthfixture.Prepare(t, pool, dir, connectionBrowserScopes)
	material := prepared.Materials
	endpoint := devicefixture.Endpoint
	var proof map[string]any
	if err := protocol.Decode(material.Genesis.GenesisProof, &proof); err != nil {
		t.Fatal(err)
	}
	write := func(name string, value any) {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := writeJSON(path, value); err != nil {
			t.Fatal(err)
		}
	}
	write("galaxy-id.json", map[string]any{"id": material.Genesis.ID, "genesisProof": proof})
	if err := os.WriteFile(filepath.Join(dir, "galaxy-id-private-key.pem"), []byte(material.OwnerPrivate), 0600); err != nil {
		t.Fatal(err)
	}
	active := map[string]any{"subjectId": material.Genesis.ID, "deviceId": material.DeviceID, "installationId": material.InstallationID, "genesisProof": proof}
	permission := map[string]any{"enabled": true, "subjectId": material.Genesis.ID, "deviceId": material.DeviceID, "scopes": connectionBrowserScopes}
	selectionPath := connectionRecordPath(dir, "native-selection:"+endpoint)
	if err := os.MkdirAll(filepath.Dir(selectionPath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(selectionPath, map[string]any{"version": 1, "revision": 1, "active": active, "permission": permission}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(connectionRecordPath(dir, "device:"+material.Genesis.ID+":"+material.DeviceID), map[string]any{"nativeDeviceKey": material.DeviceID, "nativeGenesis": true, "publicKeyPem": material.PublicKeyPEM}); err != nil {
		t.Fatal(err)
	}
	state, err := prepared.Service.ControlPublicState(ctx, material.Genesis.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = writeJSON(connectionRecordPath(dir, "native-trust-identity:"+endpoint+":"+material.Genesis.ID), state); err != nil {
		t.Fatal(err)
	}
	// A synthetic retained operation, as in the deviceauth receipt regression; this
	// tests receipt access and response privacy, not an invented upload/ACK event.
	operation := ReceiptOperation{Kind: "choice-snapshot", SnapshotID: uuid.NewString(), VersionID: uuid.NewString(), RequestHash: strings.Repeat("a", 64)}
	at := time.Unix(devicefixture.Now, 0)
	if _, err = pool.Exec(ctx, "INSERT INTO choice_snapshot_heads(subject_id,snapshot_id,created_at,updated_at) VALUES($1,$2,$3,$3)", material.Genesis.ID, operation.SnapshotID, at); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO choice_snapshot_versions(subject_id,snapshot_id,version_id,base_revision,revision,request_hash,state,content,dependencies,created_at,expires_at) VALUES($1,$2,$3,0,1,$4,'current','{"privateBody":"must never appear"}','[]',$5,$6)`, material.Genesis.ID, operation.SnapshotID, operation.VersionID, operation.RequestHash, at, at.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(deviceauth.Handler{Service: prepared.Service})
	t.Cleanup(server.Close)
	origin, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	store, err := NewStore(dir, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	metadata := connectionFixtureMetadata{Configuration: Configuration{Version: 2, Endpoint: endpoint, Website: "https://galaxy.example.org", DataDirectory: dir, TrustedKeys: map[string]Pin{"fixture": {KID: "fixture", PublicKeyPEM: material.HubPublic, NotBefore: devicefixture.Now - 100, NotAfter: devicefixture.Now + 100000}}}, Origin: server.URL, Now: devicefixture.Now, Operation: operation}
	return store, metadata, &connectionTestTransport{origin: origin}, prepared
}

func TestConnectionRestoresSavedChoiceAndRetainedReceipt(t *testing.T) {
	store, meta, transport := connectionServiceFixture(t)
	ctx := context.Background()
	now := time.Unix(meta.Now, 0)
	connection, e := NewConnection(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return now }})
	if e != nil {
		t.Fatal(e)
	}
	defer connection.Close()
	selectionPath := connectionRecordPath(store.Directory, "native-selection:"+store.Endpoint)
	selectionBefore, e := os.ReadFile(selectionPath)
	if e != nil {
		t.Fatal(e)
	}
	snapshot, e := connection.Snapshot(ctx)
	if e != nil || snapshot != nil {
		t.Fatal("new Go runtime claimed connected")
	}
	receipt, e := connection.QueryReceipt(ctx, meta.Operation)
	if e != nil {
		t.Fatal(e)
	}
	if receipt["state"] != "acknowledged" || receipt["currentAccessGranted"] != false || receipt["contentReturned"] != false {
		t.Fatal("original receipt not retained")
	}
	encodedReceipt, err := json.Marshal(receipt)
	if err != nil || strings.Contains(string(encodedReceipt), "must never appear") {
		t.Fatal("retained receipt exposed content", err)
	}
	if transport.count() != 2 {
		t.Fatalf("receipt created ordinary connection: %v", transport.paths)
	}
	for _, auth := range transport.authorization {
		if auth {
			t.Fatal("receipt used ordinary credential")
		}
	}
	unknownOperation := meta.Operation
	unknownOperation.VersionID = uuid.NewString()
	unknownReceipt, err := connection.QueryReceipt(ctx, unknownOperation)
	if err != nil || unknownReceipt["state"] != "absent" || unknownReceipt["contentReturned"] != false {
		t.Fatal("absent receipt changed", unknownReceipt, err)
	}
	snapshot, e = connection.Restore(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if snapshot == nil || snapshot.SubjectID == "" || snapshot.BindingID == "" || snapshot.Control["epoch"] == nil {
		t.Fatal("original device restore failed")
	}
	selectionAfter, e := os.ReadFile(selectionPath)
	if e != nil || string(selectionAfter) != string(selectionBefore) {
		t.Fatal("restore rewrote original selection")
	}
	if got, e := connection.Call(ctx, "/v2/identity/"+snapshot.SubjectID+"/control", nil, ConnectionCallOptions{Method: "GET"}); e != nil || got["subjectId"] != snapshot.SubjectID {
		t.Fatalf("authenticated call: %v", e)
	}
	start := transport.count()
	if _, e = connection.Call(ctx, "/v2/context/grants", map[string]any{"materials": []any{map[string]any{"text": "private work"}}}, ConnectionCallOptions{}); fault.Code(e) != "local_upload_type_not_allowed" {
		t.Fatalf("upload privacy lost: %v", e)
	}
	if transport.count() != start {
		t.Fatal("excluded local material sent")
	}
	if _, e = connection.Call(ctx, "https://other.invalid/v1/data", nil, ConnectionCallOptions{}); fault.Code(e) != "native_api_path_invalid" {
		t.Fatalf("caller changed authority: %v", e)
	}
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v1/isolated-unknown" {
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	start = transport.count()
	_, e = connection.Call(ctx, "/v1/isolated-unknown", map[string]any{"operationId": meta.Operation.VersionID}, ConnectionCallOptions{})
	var unknown *ConnectionRequestError
	if !errors.As(e, &unknown) || unknown.Outcome != "unknown" || transport.count() != start+1 {
		t.Fatalf("unknown request replayed or misreported: %v", e)
	}
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v1/isolated-rejected" {
			response.Body.Close()
			response.StatusCode = 403
			response.Body = io.NopCloser(strings.NewReader(`{"error":"access_denied"}`))
			response.ContentLength = -1
		}
		return response, nil
	})
	_, e = connection.Call(ctx, "/v1/isolated-rejected", map[string]any{}, ConnectionCallOptions{})
	var rejected *ConnectionHTTPError
	if !errors.As(e, &rejected) || rejected.Code != "access_denied" || rejected.Outcome != "rejected" {
		t.Fatalf("explicit rejection masked: %v", e)
	}
	if current, e := connection.Snapshot(ctx); e != nil || current != nil {
		t.Fatal("explicit revocation retained ordinary credential")
	}
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/receipt-status/challenges" {
			connection.Disconnect()
		}
		return response, nil
	})
	start = transport.count()
	if _, e = connection.QueryReceipt(ctx, meta.Operation); fault.Code(e) != "receipt_status_authority_changed" {
		t.Fatalf("receipt lifecycle ABA accepted: %v", e)
	}
	if transport.count() != start+1 {
		t.Fatal("old receipt challenge signed after disconnect")
	}
	transport.setHook(nil)
	wrong := meta.Configuration
	wrong.Endpoint = meta.Origin
	if _, e = NewConnection(store, wrong, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}}); fault.Code(e) != "native_connection_configuration_invalid" {
		t.Fatal("test transport allowed HTTP production authority")
	}
	blockedConfig := meta.Configuration
	blockedConfig.TrustedKeys = map[string]Pin{}
	for id, pin := range meta.Configuration.TrustedKeys {
		deadline := meta.Now
		pin.TrustedUntil = &deadline
		blockedConfig.TrustedKeys[id] = pin
	}
	blocked, e := NewConnection(store, blockedConfig, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return now }})
	if e != nil {
		t.Fatal(e)
	}
	start = transport.count()
	if _, e = blocked.Restore(ctx); fault.Code(e) != "native_server_pin_invalid" {
		t.Fatalf("pin trust deadline ignored: %v", e)
	}
	if transport.count() != start+2 {
		t.Fatal("untrusted challenge signed")
	}
	blocked.Close()
	changing, e := NewConnection(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return now }})
	if e != nil {
		t.Fatal(e)
	}
	var mutationError error
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/binding-challenges" {
			mutationError = store.With(ctx, true, func(dir string) error {
				var record map[string]any
				if _, e := readJSON(selectionPath, &record); e != nil {
					return e
				}
				record["revision"] = integer(record["revision"]) + 1
				return writeJSON(selectionPath, record)
			})
		}
		return response, nil
	})
	start = transport.count()
	if _, e = changing.Restore(ctx); fault.Code(e) != "native_connection_selection_changed" || mutationError != nil {
		t.Fatalf("late selection accepted: %v %v", e, mutationError)
	}
	if transport.count() != start+2 {
		t.Fatal("old owner signed after selection changed")
	}
	changing.Close()
	transport.setHook(nil)
	connection.Close()
	if _, e = connection.Restore(ctx); fault.Code(e) != "native_runtime_closed" {
		t.Fatalf("closed connection restored: %v", e)
	}
}
func TestConnectionRejectsTrailingJSON(t *testing.T) {
	for _, raw := range []string{`{} true`, `{} trailing`, `null`, `[]`} {
		if _, e := connectionObject([]byte(raw)); e == nil {
			t.Fatalf("invalid response accepted: %s", raw)
		}
	}
	if _, e := connectionObject([]byte("{} \r\n")); e != nil {
		t.Fatal(e)
	}
}
