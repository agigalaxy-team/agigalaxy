package deviceauth

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Configuration references the unchanged original server environment files.
// Load persists only public trust history; private bytes stay in the signer.
type Configuration struct {
	Endpoint, SigningKeyFile, SigningKeyID, RootPinsFile, KeyringFile, TrustDirectory string
	AllowedScopes                                                                     []string
	Now                                                                               func() time.Time
}
type configuredKey struct {
	KID          string `json:"kid"`
	PublicKeyPEM string `json:"publicKeyPem"`
	NotBefore    int64  `json:"notBefore"`
	NotAfter     int64  `json:"notAfter"`
	Revoked      bool   `json:"revoked"`
}
type keyringData struct {
	Version  int             `json:"version"`
	Endpoint string          `json:"endpoint"`
	Sequence int64           `json:"sequence"`
	Keys     []configuredKey `json:"keys"`
}
type trustHistory struct {
	KID         string `json:"kid"`
	Fingerprint string `json:"fingerprint"`
	Revoked     bool   `json:"revoked"`
}
type trustState struct {
	Endpoint     string         `json:"endpoint"`
	Sequence     int64          `json:"sequence"`
	DocumentHash string         `json:"documentHash"`
	History      []trustHistory `json:"history"`
}

var kidPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

func configurationError() error { return fault.New("device_auth_configuration_invalid", 400) }
func configurationRead(path string, max int64, secret bool) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, configurationError()
	}
	before, e := os.Lstat(path)
	if e != nil {
		return nil, e
	}
	if !before.Mode().IsRegular() || before.Size() > max || secret && runtime.GOOS != "windows" && before.Mode().Perm()&0077 != 0 {
		return nil, configurationError()
	}
	file, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer file.Close()
	opened, e := file.Stat()
	if e != nil || !os.SameFile(before, opened) {
		return nil, configurationError()
	}
	b, e := io.ReadAll(io.LimitReader(file, max+1))
	if e != nil {
		return nil, e
	}
	after, e := file.Stat()
	if e != nil || len(b) > int(max) || after.Size() != int64(len(b)) || !after.ModTime().Equal(opened.ModTime()) {
		return nil, configurationError()
	}
	return b, nil
}
func validateKeys(raw []byte, endpoint string) (keyringData, map[string]Pin, error) {
	var data keyringData
	if !exactJSON(raw, "version", "endpoint", "sequence", "keys") || protocol.Decode(raw, &data) != nil || data.Version != 1 || data.Endpoint != endpoint || data.Sequence < 1 || data.Sequence > 9007199254740991 || len(data.Keys) < 1 || len(data.Keys) > 32 {
		return data, nil, configurationError()
	}
	var entries struct{ Keys []json.RawMessage }
	_ = json.Unmarshal(raw, &entries)
	pins := map[string]Pin{}
	for i, k := range data.Keys {
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(entries.Keys[i], &fields)
		if string(fields["notBefore"]) == "null" || string(fields["revoked"]) != "true" && string(fields["revoked"]) != "false" {
			return data, nil, configurationError()
		}

		if !exactJSON(entries.Keys[i], "kid", "publicKeyPem", "notBefore", "notAfter", "revoked") || !kidPattern.MatchString(k.KID) || k.NotBefore < 0 || k.NotAfter <= k.NotBefore || k.NotAfter > 9007199254740991 || len(k.PublicKeyPEM) > 256 {
			return data, nil, configurationError()
		}
		if _, ok := pins[k.KID]; ok {
			return data, nil, configurationError()
		}
		key, e := parsePublic(k.PublicKeyPEM)
		if e != nil {
			return data, nil, configurationError()
		}
		canonical, e := identity.PublicPEM(key)
		if e != nil || canonical != k.PublicKeyPEM {
			return data, nil, configurationError()
		}
		pins[k.KID] = Pin{PublicKeyPEM: k.PublicKeyPEM, NotBefore: k.NotBefore, NotAfter: k.NotAfter, Revoked: k.Revoked}
	}
	return data, pins, nil
}
func Load(ctx context.Context, pool *pgxpool.Pool, c Configuration) (*Service, error) {
	return loadConfiguration(ctx, pool, c, false)
}
func loadConfiguration(ctx context.Context, pool *pgxpool.Pool, c Configuration, readOnly bool) (*Service, error) {
	origin, e := url.Parse(c.Endpoint)
	if e != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || strings.ToLower(origin.Host) != origin.Host || origin.Port() == "443" || origin.String() != c.Endpoint {
		return nil, configurationError()
	}
	now := time.Now().Unix()
	if c.Now != nil {
		now = c.Now().Unix()
	}
	var private ed25519.PrivateKey
	if !readOnly {
		if !kidPattern.MatchString(c.SigningKeyID) {
			return nil, configurationError()
		}
		keyRaw, e := configurationRead(c.SigningKeyFile, 4096, true)
		if e != nil {
			return nil, e
		}
		private, e = identity.PrivatePEM(keyRaw)
		if e != nil {
			return nil, configurationError()
		}
	}
	rootRaw, e := configurationRead(c.RootPinsFile, 65536, false)
	if e != nil {
		return nil, e
	}
	_, roots, e := validateKeys(rootRaw, c.Endpoint)
	if e != nil {
		return nil, e
	}
	documentRaw, e := configurationRead(c.KeyringFile, 65536, false)
	if e != nil {
		return nil, e
	}
	var document struct {
		Signed string `json:"signed"`
	}
	if !exactJSON(documentRaw, "signed") || protocol.Decode(documentRaw, &document) != nil {
		return nil, configurationError()
	}
	rootVerifier := &SessionKeyring{Endpoint: c.Endpoint, Pins: func() map[string]Pin { return roots }}
	opened, e := rootVerifier.verifyEnvelope(document.Signed, "keyring", 86400, now)
	if e != nil {
		return nil, configurationError()
	}
	data, pins, e := validateKeys(opened.Data, c.Endpoint)
	if e != nil {
		return nil, e
	}
	for id, p := range pins {
		deadline := opened.ExpiresAt
		p.TrustedUntil = &deadline
		pins[id] = p
	}
	// Retain the existing cross-process lock and per-endpoint public state format.
	if !filepath.IsAbs(c.TrustDirectory) {
		return nil, configurationError()
	}
	if e = os.MkdirAll(c.TrustDirectory, 0700); e != nil {
		return nil, e
	}
	info, e := os.Lstat(c.TrustDirectory)
	if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, configurationError()
	}
	name := identity.Digest([]byte(c.Endpoint))
	statePath := filepath.Join(c.TrustDirectory, name+".json")
	lockPath := filepath.Join(c.TrustDirectory, name+".lock")
	lock, e := os.OpenFile(lockPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return nil, e
	}
	defer func() { _ = lock.Close(); _ = os.Remove(lockPath) }()
	previousRaw, e := configurationRead(statePath, 1048576, false)
	var previous *trustState
	if e == nil {
		previous = &trustState{}
		if protocol.Decode(previousRaw, previous) != nil {
			return nil, configurationError()
		}
	} else if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	documentHash := identity.Digest([]byte(document.Signed))
	if previous != nil && (previous.Endpoint != c.Endpoint || previous.Sequence < 1 || data.Sequence < previous.Sequence || data.Sequence == previous.Sequence && documentHash != previous.DocumentHash) {
		return nil, configurationError()
	}
	history := []trustHistory{}
	index := map[string]int{}
	if previous != nil {
		for _, h := range previous.History {
			if !kidPattern.MatchString(h.KID) || !hashPattern.MatchString(h.Fingerprint) {
				return nil, configurationError()
			}
			index[h.KID] = len(history)
			history = append(history, h)
		}
	}
	for _, k := range data.Keys {
		h := trustHistory{k.KID, identity.Digest([]byte(k.PublicKeyPEM)), k.Revoked}
		if i, ok := index[k.KID]; ok {
			old := history[i]
			if old.Fingerprint != h.Fingerprint || old.Revoked && !h.Revoked {
				return nil, configurationError()
			}
			history[i] = h
		} else {
			index[k.KID] = len(history)
			history = append(history, h)
		}
	}
	next := trustState{c.Endpoint, data.Sequence, documentHash, history}
	stateRaw, e := protocol.Encode(next)
	if e != nil {
		return nil, e
	}
	temporary := filepath.Join(c.TrustDirectory, name+"."+uuid.NewString()+".tmp")
	defer os.Remove(temporary)
	file, e := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return nil, e
	}
	if _, e = file.Write(append(stateRaw, '\n')); e == nil {
		e = file.Sync()
	}
	closeErr := file.Close()
	if e != nil {
		return nil, e
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if e = os.Rename(temporary, statePath); e != nil {
		return nil, e
	}
	signing := &SessionKeyring{Endpoint: c.Endpoint, KID: c.SigningKeyID, Key: private, Pins: func() map[string]Pin { return pins }}
	signing.publicDocument = append(json.RawMessage(nil), documentRaw...)
	signing.trustSequence = data.Sequence
	for _, key := range data.Keys {
		signing.publicOrder = append(signing.publicOrder, key.KID)
	}
	if !readOnly {
		pin, ok := pins[c.SigningKeyID]
		if !ok || pin.Revoked || pin.NotBefore > now || pin.NotAfter < now+86400 {
			return nil, configurationError()
		}
		if _, e = signing.signEnvelope("session-challenge", Challenge{}, uuid.NewString(), now, 120); e != nil {
			return nil, configurationError()
		}
	}
	scopes := append([]string(nil), c.AllowedScopes...)
	if len(scopes) == 0 {
		scopes = append([]string(nil), DefaultScopes...)
	}
	return &Service{Pool: pool, Endpoint: c.Endpoint, Signer: signing, Now: c.Now, AllowedScopes: scopes}, nil
}
