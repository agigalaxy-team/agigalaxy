package native

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func discoverySigner(t *testing.T) (ed25519.PrivateKey, string) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return priv, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}
func discoveryToken(t *testing.T, private ed25519.PrivateKey, kid, kind, endpoint string, at int64, data map[string]any) string {
	t.Helper()
	encode := func(v any) string {
		raw, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	input := encode(map[string]any{"alg": "Ed25519", "kid": kid, "typ": "galaxy-" + kind + "+jwt"}) + "." + encode(map[string]any{"iss": endpoint, "aud": endpoint, "iat": at, "nbf": at, "exp": at + 300, "jti": "fixture", "data": data})
	return input + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, []byte(input)))
}
func TestDiscoveryRootRotationAndManifestBoundaries(t *testing.T) {
	ctx := context.Background()
	now := int64(2000000000)
	clock := func() time.Time { return time.Unix(now, 0) }
	endpoint := "https://service.example.invalid"
	root, rootPEM := discoverySigner(t)
	service, servicePEM := discoverySigner(t)
	next, nextPEM := discoverySigner(t)
	store, err := NewStore(filepath.Join(t.TempDir(), "data"), endpoint)
	if err != nil {
		t.Fatal(err)
	}
	config := Configuration{Version: 2, Endpoint: endpoint, Website: "https://web.example.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{}, RootPins: map[string]Pin{"root": {PublicKeyPEM: rootPEM, NotBefore: now - 10, NotAfter: now + 1000}}, TrustDirectory: filepath.Join(t.TempDir(), "trust")}
	r, err := NewRuntime(store, config, ConnectionOptions{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if _, err = r.Restore(ctx); err == nil {
		t.Fatal("root-managed connection started without accepted keyring")
	}
	row := func(kid, pub string, revoked bool) map[string]any {
		return map[string]any{"kid": kid, "publicKeyPem": pub, "notBefore": now - 10, "notAfter": now + 1000, "revoked": revoked}
	}
	manifest := map[string]any{"schemaVersion": 1, "networkType": "official", "displayName": "Fixture", "operator": "Operator", "endpoint": endpoint, "capabilities": []any{"binding", "sessions"}, "policy": map[string]any{"automaticUpload": false, "privateKeyCustody": "client", "url": endpoint + "/v1/policy"}, "region": "test", "serviceVersion": "0.1.0", "signingKeyId": "service", "revocationPath": "/v1/signing-keys/status"}
	sequence := 1
	keys := []any{row("service", servicePEM, false)}
	signer := service
	fetch := func(_ context.Context, address string) ([]byte, error) {
		kind, kid, data, key := "manifest", "service", manifest, signer
		if address == endpoint+"/.well-known/galaxy-signing-keys.json" {
			kind, kid, data, key = "keyring", "root", map[string]any{"version": 1, "endpoint": endpoint, "sequence": sequence, "keys": keys}, root
		}
		return json.Marshal(map[string]any{"signed": discoveryToken(t, key, kid, kind, endpoint, now, data)})
	}
	badRoot := func(_ context.Context, _ string) ([]byte, error) {
		return json.Marshal(map[string]any{"signed": discoveryToken(t, service, "root", "keyring", endpoint, now, map[string]any{"version": 1, "endpoint": endpoint, "sequence": 1, "keys": keys})})
	}
	if _, err = r.discoverWith(ctx, badRoot); err == nil {
		t.Fatal("untrusted root accepted")
	}
	if _, err = os.Stat(config.TrustDirectory); !os.IsNotExist(err) {
		t.Fatal("untrusted root created trust state")
	}
	result, err := r.discoverWith(ctx, fetch)
	if err != nil || result["state"] != "verified" || result["connected"] != false || result["authorized"] != false {
		t.Fatalf("initial discovery: %#v %v", result, err)
	}
	for _, change := range []func(){func() { manifest["schemaVersion"] = 2 }, func() { manifest["serviceVersion"] = "2.0.0" }, func() { manifest["extra"] = true }} {
		original := cloneMap(manifest)
		change()
		if _, err = r.discoverWith(ctx, fetch); err == nil {
			t.Fatal("invalid manifest accepted")
		}
		manifest = original
	}
	manifest["signingKeyId"] = "other"
	if _, err = r.discoverWith(ctx, fetch); err == nil {
		t.Fatal("mismatched signing key accepted")
	}
	manifest["signingKeyId"] = "service"
	manifest["capabilities"] = []any{"binding"}
	if _, err = r.discoverWith(ctx, fetch); err == nil {
		t.Fatal("unsupported service accepted")
	}
	manifest["capabilities"] = []any{"binding", "sessions"}
	sequence = 2
	keys = []any{row("service", servicePEM, true), row("next", nextPEM, false)}
	signer = next
	manifest["signingKeyId"] = "next"
	// The selected signing key ID is part of the protected envelope.
	fetchRotated := func(_ context.Context, address string) ([]byte, error) {
		if address == endpoint+"/.well-known/galaxy-signing-keys.json" {
			return json.Marshal(map[string]any{"signed": discoveryToken(t, root, "root", "keyring", endpoint, now, map[string]any{"version": 1, "endpoint": endpoint, "sequence": sequence, "keys": keys})})
		}
		return json.Marshal(map[string]any{"signed": discoveryToken(t, signer, "next", "manifest", endpoint, now, manifest)})
	}
	if _, err = r.discoverWith(ctx, fetchRotated); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewRuntime(store, config, ConnectionOptions{Now: clock})
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	sequence = 1
	if _, err = restarted.discoverWith(ctx, fetchRotated); err == nil {
		t.Fatal("restart lost persisted rollback boundary")
	}
	sequence = 2
	if _, err = restarted.discoverWith(ctx, fetchRotated); err != nil {
		t.Fatal(err)
	}
	keys = []any{row("service", servicePEM, true), row("next", nextPEM, true)}
	if _, err = r.discoverWith(ctx, fetchRotated); err == nil {
		t.Fatal("conflicting sequence accepted")
	}
	keys = []any{row("service", servicePEM, true), row("next", nextPEM, false)}
	sequence = 1
	if _, err = r.discoverWith(ctx, fetchRotated); err == nil {
		t.Fatal("rollback accepted")
	}
	sequence = 3
	keys = []any{row("service", servicePEM, false), row("next", nextPEM, false)}
	if _, err = r.discoverWith(ctx, fetchRotated); err == nil {
		t.Fatal("revoked key resurrected")
	}
	sequence = 4
	keys = []any{row("next", servicePEM, false)}
	if _, err = r.discoverWith(ctx, fetchRotated); err == nil {
		t.Fatal("key ID reused")
	}
	r.connection.mu.Lock()
	if !r.connection.discoveryTrustCurrentLocked() {
		t.Fatal("accepted keyring unexpectedly expired")
	}
	now += 301
	if r.connection.discoveryTrustCurrentLocked() {
		t.Fatal("expired keyring remained usable")
	}
	r.connection.mu.Unlock()
}
func cloneMap(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

func TestServiceConfigurationSelectsExplicitRootPins(t *testing.T) {
	_, public := discoverySigner(t)
	dir := t.TempDir()
	rootFile := filepath.Join(dir, "roots.json")
	root := map[string]Pin{"root": {PublicKeyPEM: public, NotBefore: 1, NotAfter: 4102444800}}
	raw, _ := json.Marshal(root)
	if err := os.WriteFile(rootFile, raw, 0600); err != nil {
		t.Fatal(err)
	}
	service, _ := json.Marshal(map[string]any{"version": 1, "endpoint": "https://api.configuration.invalid", "operator": "fixture", "signingKeys": []any{map[string]any{"kid": "service", "publicKeyPem": public, "notBefore": 1, "notAfter": 4102444800, "revoked": false}}})
	transport := &serviceConfigurationTransport{raw: string(service)}
	request := ServiceConfigurationRequest{Website: "https://configuration.invalid", Endpoint: "https://api.configuration.invalid", DataDirectory: filepath.Join(dir, "data"), Output: filepath.Join(dir, "config.json"), RootPinsFile: rootFile, TrustDirectory: filepath.Join(dir, "trust"), NetworkType: "hub"}
	result, err := PrepareServiceConfiguration(context.Background(), request, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: transport}})
	if err != nil || uploadObject(result)["trustSource"] != "explicitly-selected-root-pins" {
		t.Fatalf("prepare: %#v %v", result, err)
	}
	config, err := ReadConfiguration(request.Output)
	if err != nil || config.RootPins["root"].PublicKeyPEM != public || config.NetworkType != "hub" || config.TrustDirectory != request.TrustDirectory {
		t.Fatalf("configuration: %#v %v", config, err)
	}
	if _, err = os.Stat(request.TrustDirectory); !os.IsNotExist(err) {
		t.Fatal("preparation created trust state")
	}
	rootDocument, _ := json.Marshal(map[string]any{"version": 1, "endpoint": request.Endpoint, "sequence": 1, "keys": []any{map[string]any{"kid": "root", "publicKeyPem": public, "notBefore": 1, "notAfter": 4102444800, "revoked": false}}})
	if err = os.WriteFile(rootFile, rootDocument, 0600); err != nil {
		t.Fatal(err)
	}
	request.Output = filepath.Join(dir, "document-config.json")
	if _, err = PrepareServiceConfiguration(context.Background(), request, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: transport}}); err != nil {
		t.Fatal("existing root document rejected", err)
	}
	rootDocument, _ = json.Marshal(map[string]any{"version": 1, "endpoint": "https://other.invalid", "sequence": 1, "keys": []any{map[string]any{"kid": "root", "publicKeyPem": public, "notBefore": 1, "notAfter": 4102444800, "revoked": false}}})
	if err = os.WriteFile(rootFile, rootDocument, 0600); err != nil {
		t.Fatal(err)
	}
	request.Output = filepath.Join(dir, "wrong-origin.json")
	if _, err = PrepareServiceConfiguration(context.Background(), request, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: transport}}); err == nil {
		t.Fatal("root document from another authority accepted")
	}
	missingStart, _ := json.Marshal(map[string]any{"root": map[string]any{"publicKeyPem": public, "notAfter": 4102444800, "revoked": false}})
	if err = os.WriteFile(rootFile, missingStart, 0600); err != nil {
		t.Fatal(err)
	}
	request.Output = filepath.Join(dir, "missing-boundary.json")
	if _, err = PrepareServiceConfiguration(context.Background(), request, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: transport}}); err == nil {
		t.Fatal("root without start boundary accepted")
	}
	invalidRoots := []any{
		map[string]any{"root": map[string]any{"publicKeyPem": public, "notBefore": 1, "notAfter": 4102444800}},
		map[string]any{"root": map[string]any{"publicKeyPem": public, "notBefore": -1, "notAfter": 4102444800, "revoked": false}},
		map[string]any{"root": map[string]any{"publicKeyPem": public, "notBefore": 1, "notAfter": 9007199254740992, "revoked": false}},
		map[string]any{"root": map[string]any{"publicKeyPem": public, "notBefore": 1, "notAfter": 4102444800, "revoked": false, "trustedUntil": nil}},
		map[string]any{"version": 1, "endpoint": request.Endpoint, "sequence": 1, "keys": []any{map[string]any{"kid": "root", "publicKeyPem": public + " ", "notBefore": 1, "notAfter": 4102444800, "revoked": false}}},
		map[string]any{"version": 1, "endpoint": request.Endpoint, "sequence": 1, "keys": []any{map[string]any{"kid": "root", "publicKeyPem": public, "notBefore": 1, "notAfter": 4102444800, "revoked": false, "extra": true}}},
	}
	for index, value := range invalidRoots {
		raw, _ = json.Marshal(value)
		if err = os.WriteFile(rootFile, raw, 0600); err != nil {
			t.Fatal(err)
		}
		request.Output = filepath.Join(dir, fmt.Sprintf("bad-root-%d.json", index))
		if _, err = PrepareServiceConfiguration(context.Background(), request, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: transport}}); err == nil {
			t.Fatalf("invalid root %d accepted", index)
		}
	}
	request.Output = filepath.Join(dir, "invalid.json")
	request.TrustDirectory = ""
	if _, err = PrepareServiceConfiguration(context.Background(), request, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: transport}}); err == nil {
		t.Fatal("partial root selection accepted")
	}
}
