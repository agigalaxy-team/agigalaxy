package servicemetadata

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

func TestOriginalPublicDiscoveryAndFirstDeviceHandshake(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	origin := ""
	node := func(script, mode string) {
		t.Helper()
		cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go", script), mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_DEVICE_DIR="+dir, "GALAXY_GO_TEST_DEVICE_ORIGIN="+origin)
		if out, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("original JS %s: %v %s", mode, e, out)
		}
	}
	node("device-auth-interop.mjs", "setup")
	pool, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	at := int64(2000000000)
	now := func() time.Time { return time.Unix(at, 0) }
	devices, e := deviceauth.Load(ctx, pool, deviceauth.Configuration{Endpoint: "https://device.example.invalid", SigningKeyID: "fixture", SigningKeyFile: filepath.Join(dir, "hub-private.pem"), RootPinsFile: filepath.Join(dir, "root-pins.json"), KeyringFile: filepath.Join(dir, "keyring.json"), TrustDirectory: filepath.Join(dir, "trust"), Now: now})
	if e != nil {
		t.Fatal(e)
	}
	signer := devices.Signer.(*deviceauth.SessionKeyring)
	config := Configuration{Endpoint: devices.Endpoint, SigningKeyID: signer.KID, Operator: "Original operator", Region: "test", Keyring: signer.PublicKeyring(), SignManifest: signer.SignManifest, AssertManifestAvailable: signer.AssertManifestAvailable, KeyStatuses: signer.SigningKeyStatuses, Now: now}
	service, e := New(config)
	if e != nil {
		t.Fatal(e)
	}
	server := httptest.NewServer(Handler{Service: service, Next: deviceauth.Handler{Service: devices}})
	defer server.Close()
	origin = server.URL
	node("service-metadata-interop.mjs", "official")
	// The original connection client now follows successful public discovery;
	// every binding/session request reaches this same Go handler chain.
	node("device-auth-interop.mjs", "client")
	before, tag, e := service.manifest(ctx)
	if e != nil {
		t.Fatal(e)
	}
	at += 59
	cached, tag2, e := service.manifest(ctx)
	if e != nil || before["signed"] != cached["signed"] || tag != tag2 {
		t.Fatal("cache changed before original refresh boundary", e)
	}
	at++
	renewed, tag3, e := service.manifest(ctx)
	if e != nil || renewed["signed"] == before["signed"] || tag3 == tag {
		t.Fatal("manifest did not renew at 60 seconds", e)
	}
	pins := signer.Pins()
	p := pins[signer.KID]
	p.Revoked = true
	pins[signer.KID] = p
	request := httptest.NewRequest("GET", "/.well-known/galaxy-network.json", nil)
	request.Header.Set("If-None-Match", tag3)
	out := httptest.NewRecorder()
	Handler{Service: service}.ServeHTTP(out, request)
	if out.Code != 503 || out.Header().Get("ETag") != "" {
		t.Fatal("revoked cached manifest returned success", out.Code)
	}
	p.Revoked = false
	pins[signer.KID] = p
	at = 2000000000
	// The verified public document is a defensive copy, including its backing bytes.
	copied := signer.PublicKeyring()
	copied[0] = '!'
	if !json.Valid(signer.PublicKeyring()) {
		t.Fatal("public document escaped ownership")
	}
	profilePath := filepath.Join(dir, "hub.json")
	_ = os.WriteFile(profilePath, []byte(`{"networkType":"hub","displayName":"Independent Hub","serviceVersion":"1.2.3","hub":{"profile":"galaxy-hub/1","charter":"https://hub.example.invalid/charter","scope":"shared work","exit":"leave freely","export":"take your data"}}`), 0600)
	config.NetworkProfileFile = profilePath
	hubService, e := New(config)
	if e != nil {
		t.Fatal(e)
	}
	hubServer := httptest.NewServer(Handler{Service: hubService})
	defer hubServer.Close()
	origin = hubServer.URL
	node("service-metadata-interop.mjs", "hub")
}
