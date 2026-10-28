// Package servicemetadata serves the original public network discovery contract.
// It receives a purpose-limited signer and the already verified public keyring.
package servicemetadata

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type KeyStatus = deviceauth.SigningKeyStatus
type Configuration struct {
	Endpoint, SigningKeyID, Operator, Region, NetworkProfileFile string
	// Nil capabilities retain the original advertised service defaults.
	Capabilities            []string
	Keyring                 json.RawMessage
	SignManifest            func(context.Context, any, int64) (string, error)
	AssertManifestAvailable func(int64) error
	KeyStatuses             func() []KeyStatus
	Now                     func() time.Time
}
type Service struct {
	c         Configuration
	data      map[string]any
	mu        sync.Mutex
	document  map[string]string
	etag      string
	refreshAt int64
}

func New(c Configuration) (*Service, error) {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.SignManifest == nil || c.AssertManifestAvailable == nil || c.KeyStatuses == nil || !json.Valid(c.Keyring) {
		return nil, invalid()
	}
	var keys map[string]json.RawMessage
	if json.Unmarshal(c.Keyring, &keys) != nil || len(keys) != 1 || len(keys["signed"]) == 0 {
		return nil, invalid()
	}
	var signed string
	if json.Unmarshal(keys["signed"], &signed) != nil || signed == "" {
		return nil, invalid()
	}
	c.Keyring = append(json.RawMessage(nil), c.Keyring...)
	profile, e := loadProfile(c.NetworkProfileFile)
	if e != nil {
		return nil, e
	}
	if c.Capabilities == nil {
		c.Capabilities = []string{"binding", "sessions", "docs-mcp"}
	}
	c.Capabilities = append([]string{}, c.Capabilities...)
	d := map[string]any{"schemaVersion": 1, "networkType": profile.NetworkType, "displayName": profile.DisplayName, "operator": c.Operator, "endpoint": c.Endpoint, "capabilities": c.Capabilities, "policy": map[string]any{"automaticUpload": false, "privateKeyCustody": "client", "url": c.Endpoint + "/v1/policy"}, "region": c.Region, "serviceVersion": profile.ServiceVersion, "signingKeyId": c.SigningKeyID, "revocationPath": "/v1/signing-keys/status"}
	if profile.NetworkType == "hub" {
		d["hub"] = profile.Hub
	}
	if e = validate(c, profile); e != nil {
		return nil, e
	}
	return &Service{c: c, data: d}, nil
}
func invalid() error { return fault.New("network_metadata_configuration_invalid", 400) }
func (s *Service) manifest(ctx context.Context) (map[string]string, string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	at := s.c.Now().Unix()
	// Availability must be checked even for a cached document or a 304 response.
	if e := s.c.AssertManifestAvailable(at); e != nil {
		return nil, "", e
	}
	if s.document == nil || s.refreshAt <= at {
		signed, e := s.c.SignManifest(ctx, s.data, at)
		if e != nil {
			return nil, "", e
		}
		sum := sha256.Sum256([]byte(signed))
		s.etag = "\"" + hex.EncodeToString(sum[:]) + "\""
		s.document = map[string]string{"signed": signed}
		s.refreshAt = at + 60
	}
	return s.document, s.etag, nil
}
