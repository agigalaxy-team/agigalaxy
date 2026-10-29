package native

import (
	"context"
	"crypto/x509"
	"encoding/pem"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
)

var discoveryKID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
var discoveryVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)

func discoveryRootPinsValid(pins map[string]any) bool {
	if len(pins) == 0 || len(pins) > 32 {
		return false
	}
	for id, raw := range pins {
		row, ok := raw.(map[string]any)
		if !ok || !discoveryKID.MatchString(id) {
			return false
		}
		for key := range row {
			if !isOne(key, "kid", "publicKeyPem", "notBefore", "notAfter", "revoked", "trustedUntil") {
				return false
			}
		}
		if !connectionSafeInteger(row["notBefore"]) || !connectionSafeInteger(row["notAfter"]) || integer(row["notAfter"]) <= integer(row["notBefore"]) {
			return false
		}
		if _, ok = row["revoked"].(bool); !ok {
			return false
		}
		if v, present := row["trustedUntil"]; present && !connectionSafeInteger(v) {
			return false
		}
		pemText, ok := row["publicKeyPem"].(string)
		if !ok || len(pemText) > 256 {
			return false
		}
		if _, err := connectionPublicPEM(pemText); err != nil {
			return false
		}
	}
	return true
}

// Caller holds c.mu. Root-managed keys expire together with their keyring.
func (c *Connection) discoveryTrustCurrentLocked() bool {
	if len(c.config.RootPins) == 0 {
		return true
	}
	for _, pin := range c.config.TrustedKeys {
		if pin.TrustedUntil != nil && c.now().Unix() < *pin.TrustedUntil {
			return true
		}
	}
	return false
}

// Each keyring is verified and durably committed before its keys can be used.
// The on-disk format is shared with the original host trust store.
func discoveryKeyring(directory, endpoint, signed string, root map[string]Pin, now func() time.Time) (map[string]Pin, int64, error) {
	if !filepath.IsAbs(directory) || len(root) == 0 {
		return nil, 0, connectionFailure("native_discovery_configuration_invalid")
	}
	verifier := &Connection{config: Configuration{Endpoint: endpoint, TrustedKeys: root}, now: now}
	opened, err := verifier.envelope(signed, "keyring", 86400)
	if err != nil {
		return nil, 0, err
	}
	d := opened.Data
	keys, ok := d["keys"].([]any)
	if !connectionExact(d, "endpoint", "keys", "sequence", "version") || d["endpoint"] != endpoint || integer(d["version"]) != 1 || !connectionSafeInteger(d["sequence"]) || integer(d["sequence"]) < 1 || !ok || len(keys) < 1 || len(keys) > 32 {
		return nil, 0, connectionFailure("native_keyring_invalid")
	}
	if err = os.MkdirAll(directory, 0700); err != nil {
		return nil, 0, err
	}
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, 0, connectionFailure("native_keyring_store_invalid")
	}
	name := identity.Digest([]byte(endpoint))
	path := filepath.Join(directory, name+".json")
	lockPath := filepath.Join(directory, name+".lock")
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = lock.Close(); _ = os.Remove(lockPath) }()
	var previous map[string]any
	info, err = os.Lstat(path)
	if err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > 1048576 {
			return nil, 0, connectionFailure("native_keyring_store_invalid")
		}
		raw, e := os.ReadFile(path)
		if e != nil {
			return nil, 0, e
		}
		previous, e = connectionObject(raw)
		if e != nil {
			return nil, 0, e
		}
	} else if !os.IsNotExist(err) {
		return nil, 0, err
	}
	hash := identity.Digest([]byte(signed))
	sequence := integer(d["sequence"])
	if previous != nil && (previous["endpoint"] != endpoint || !connectionSafeInteger(previous["sequence"]) || sequence < integer(previous["sequence"]) || sequence == integer(previous["sequence"]) && previous["documentHash"] != hash) {
		return nil, 0, connectionFailure("native_keyring_rollback")
	}
	history := []any{}
	byID := map[string]int{}
	if previous != nil {
		if _, ok := previous["history"].([]any); !ok {
			return nil, 0, connectionFailure("native_keyring_store_invalid")
		}
		for _, item := range uploadRows(previous["history"]) {
			row := uploadObject(item)
			id := text(row["kid"])
			if !discoveryKID.MatchString(id) || !connectionHash.MatchString(text(row["fingerprint"])) {
				return nil, 0, connectionFailure("native_keyring_store_invalid")
			}
			if _, exists := byID[id]; exists {
				return nil, 0, connectionFailure("native_keyring_store_invalid")
			}
			if _, ok := row["revoked"].(bool); !ok {
				return nil, 0, connectionFailure("native_keyring_store_invalid")
			}
			byID[id] = len(history)
			history = append(history, row)
		}
	}
	pins := map[string]Pin{}
	for _, item := range keys {
		row := uploadObject(item)
		id := text(row["kid"])
		public := text(row["publicKeyPem"])
		before, after := integer(row["notBefore"]), integer(row["notAfter"])
		revoked, valid := row["revoked"].(bool)
		if !connectionExact(row, "kid", "notAfter", "notBefore", "publicKeyPem", "revoked") || !discoveryKID.MatchString(id) || !connectionSafeInteger(row["notBefore"]) || !connectionSafeInteger(row["notAfter"]) || after <= before || len(public) > 256 || !valid {
			return nil, 0, connectionFailure("native_keyring_invalid")
		}
		if _, exists := pins[id]; exists {
			return nil, 0, connectionFailure("native_keyring_invalid")
		}
		key, e := connectionPublicPEM(public)
		if e != nil {
			return nil, 0, e
		}
		der, e := x509.MarshalPKIXPublicKey(key)
		if e != nil || string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})) != public {
			return nil, 0, connectionFailure("native_keyring_invalid")
		}
		fingerprint := identity.Digest([]byte(public))
		if index, exists := byID[id]; exists {
			old := uploadObject(history[index])
			if old["fingerprint"] != fingerprint || old["revoked"] == true && !revoked {
				return nil, 0, connectionFailure("native_keyring_key_reused")
			}
			history[index] = map[string]any{"kid": id, "fingerprint": fingerprint, "revoked": revoked}
		} else {
			byID[id] = len(history)
			history = append(history, map[string]any{"kid": id, "fingerprint": fingerprint, "revoked": revoked})
		}
		until := opened.ExpiresAt
		pins[id] = Pin{PublicKeyPEM: public, NotBefore: before, NotAfter: after, Revoked: revoked, TrustedUntil: &until}
	}
	if err = writeJSON(path, map[string]any{"endpoint": endpoint, "sequence": sequence, "documentHash": hash, "history": history}); err != nil {
		return nil, 0, err
	}
	return pins, sequence, nil
}

func discoveryManifest(data map[string]any, endpoint, networkType, kid string) error {
	keys := []string{"schemaVersion", "networkType", "displayName", "operator", "endpoint", "capabilities", "policy", "region", "serviceVersion", "signingKeyId", "revocationPath"}
	if networkType == "hub" {
		keys = append(keys, "hub")
	}
	if !connectionExact(data, keys...) || integer(data["schemaVersion"]) != 1 || data["networkType"] != networkType || data["endpoint"] != endpoint || data["signingKeyId"] != kid || data["revocationPath"] != "/v1/signing-keys/status" {
		return connectionFailure("native_manifest_invalid")
	}
	version := text(data["serviceVersion"])
	if networkType == "official" && version != "0.1.0" || networkType == "hub" && (len(version) > 80 || !discoveryVersion.MatchString(version)) {
		return connectionFailure("native_manifest_invalid")
	}
	for _, field := range []string{"displayName", "operator", "region", "signingKeyId"} {
		v, ok := data[field].(string)
		if !ok || len(v) == 0 || protocol.TextLength(v) > 240 {
			return connectionFailure("native_manifest_invalid")
		}
	}
	caps, ok := connectionStrings(data["capabilities"])
	seen := map[string]bool{}
	if !ok {
		return connectionFailure("native_manifest_invalid")
	}
	for _, c := range caps {
		if seen[c] || !isOne(c, "binding", "sessions", "docs-mcp") {
			return connectionFailure("native_manifest_invalid")
		}
		seen[c] = true
	}
	p := uploadObject(data["policy"])
	if !connectionExact(p, "automaticUpload", "privateKeyCustody", "url") || p["automaticUpload"] != false || p["privateKeyCustody"] != "client" {
		return connectionFailure("native_manifest_invalid")
	}
	u, err := url.Parse(text(p["url"]))
	if err != nil || u.Scheme+"://"+u.Host != endpoint || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return connectionFailure("native_manifest_invalid")
	}
	if networkType == "hub" {
		h := uploadObject(data["hub"])
		if !connectionExact(h, "charter", "exit", "export", "profile", "scope") || h["profile"] != "galaxy-hub/1" || !publicfetch.ValidURL(endpoint) || !publicfetch.ValidURL(text(h["charter"])) || protocol.TextLength(text(h["charter"])) > 500 {
			return connectionFailure("native_manifest_invalid")
		}
		for _, k := range []string{"scope", "exit", "export"} {
			v := text(h[k])
			if strings.TrimSpace(v) == "" || protocol.TextLength(v) > 1500 || strings.IndexFunc(v, unicode.IsControl) >= 0 {
				return connectionFailure("native_manifest_invalid")
			}
		}
	}
	return nil
}

// Discover performs only an explicit anonymous read; it never connects or
// grants authority. Existing public-fetch enforces the public DNS/TLS boundary.
func (r *Runtime) Discover(ctx context.Context) (map[string]any, error) {
	return r.discoverWith(ctx, func(ctx context.Context, address string) ([]byte, error) {
		return publicfetch.Get(ctx, address, 65536, 5*time.Second)
	})
}
func (r *Runtime) discoverWith(ctx context.Context, fetch func(context.Context, string) ([]byte, error)) (map[string]any, error) {
	r.discoveryMu.Lock()
	defer r.discoveryMu.Unlock()
	if !publicfetch.ValidURL(r.config.Endpoint) {
		return nil, connectionFailure("native_discovery_configuration_invalid")
	}
	mode := r.config.NetworkType
	if mode == "" {
		mode = "official"
	}
	if mode != "official" && mode != "hub" {
		return nil, connectionFailure("native_discovery_configuration_invalid")
	}
	var sequence any
	if len(r.config.RootPins) > 0 {
		raw, err := fetch(ctx, r.config.Endpoint+"/.well-known/galaxy-signing-keys.json")
		if err != nil {
			return nil, err
		}
		document, err := connectionObject(raw)
		if err != nil || !connectionExact(document, "signed") {
			return nil, connectionFailure("native_keyring_invalid")
		}
		pins, seq, err := discoveryKeyring(r.config.TrustDirectory, r.config.Endpoint, text(document["signed"]), r.config.RootPins, r.connection.now)
		if err != nil {
			return nil, err
		}
		sequence = seq
		r.mu.Lock()
		if r.closed {
			r.mu.Unlock()
			return nil, connectionFailure("native_runtime_closed")
		}
		r.rotateLocked()
		r.connection.mu.Lock()
		r.connection.config.TrustedKeys = pins
		r.connection.session = nil
		r.connection.generation++
		r.connection.mu.Unlock()
		r.mu.Unlock()
	}
	raw, err := fetch(ctx, r.config.Endpoint+"/.well-known/galaxy-network.json")
	if err != nil {
		return nil, err
	}
	document, err := connectionObject(raw)
	if err != nil || !connectionExact(document, "signed") {
		return nil, connectionFailure("native_manifest_invalid")
	}
	opened, err := r.connection.envelope(text(document["signed"]), "manifest", 300)
	if err != nil {
		return nil, err
	}
	if err = discoveryManifest(opened.Data, r.config.Endpoint, mode, opened.KID); err != nil {
		return nil, err
	}
	caps, _ := connectionStrings(opened.Data["capabilities"])
	if !connectionIncludes(caps, "binding") || !connectionIncludes(caps, "sessions") {
		return nil, connectionFailure("native_manifest_unsupported")
	}
	out := map[string]any{"state": "verified", "endpoint": r.config.Endpoint, "networkType": mode, "displayName": opened.Data["displayName"], "operator": opened.Data["operator"], "checkedAt": r.connection.now().Unix(), "expiresAt": opened.ExpiresAt, "connected": false, "authorized": false, "trustSequence": sequence}
	if mode == "hub" {
		digest, e := connectionCanonicalHash(opened.Data)
		if e != nil {
			return nil, e
		}
		out["profile"] = "galaxy-hub/1"
		out["manifestSha256"] = digest
	}
	return out, nil
}
