package deviceauth

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

// AssertManifestAvailable preserves the original live signing availability
// check, including while a consumer reuses its cached public manifest.
func (k *SessionKeyring) AssertManifestAvailable(at int64) error {
	if k == nil {
		return fault.New("signing_unavailable", 503)
	}
	p, e := k.pin(k.KID, at)
	if e != nil || p.NotAfter < at+300 {
		return fault.New("signing_unavailable", 503)
	}
	return nil
}
func (k *SessionKeyring) SignManifest(ctx context.Context, data any, at int64) (string, error) {
	if e := k.AssertManifestAvailable(at); e != nil {
		return "", e
	}
	raw, e := json.Marshal(data)
	var object map[string]json.RawMessage
	if e != nil || json.Unmarshal(raw, &object) != nil || object == nil {
		return "", fault.New("invalid_request", 400)
	}
	return k.signEnvelope("manifest", data, uuid.NewString(), at, 300)
}

type SigningKeyStatus struct {
	KID       string `json:"kid"`
	Revoked   bool   `json:"revoked"`
	NotBefore int64  `json:"notBefore"`
	NotAfter  int64  `json:"notAfter"`
}

// PublicKeyring returns only the original root-verified public document.
func (k *SessionKeyring) PublicKeyring() json.RawMessage {
	if k == nil {
		return nil
	}
	return append(json.RawMessage(nil), k.publicDocument...)
}
func (k *SessionKeyring) SigningKeyStatuses() []SigningKeyStatus {
	result := []SigningKeyStatus{}
	if k == nil || k.Pins == nil {
		return result
	}
	pins := k.Pins()
	for _, id := range k.publicOrder {
		if p, ok := pins[id]; ok {
			result = append(result, SigningKeyStatus{id, p.Revoked, p.NotBefore, p.NotAfter})
		}
	}
	return result
}
