package deviceauth

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// SignConformance supplies the two existing portable-export purposes. The
// builders owner still checks the current source, disclosure and grant window.
func (k *SessionKeyring) SignConformance(ctx context.Context, kind string, data any, id string, at, age int64) (string, error) {
	if kind != "node-control" && kind != "conformance" {
		return "", fault.New("signing_purpose_denied", 403)
	}
	return k.signShortDomain(ctx, kind, data, id, at, age)
}

// SignHubPeering never grants a remote peer local session or device authority.
func (k *SessionKeyring) SignHubPeering(ctx context.Context, data any, id string, at, age int64) (string, error) {
	return k.signShortDomain(ctx, "hub-peering", data, id, at, age)
}

func (k *SessionKeyring) signShortDomain(ctx context.Context, kind string, data any, id string, at, age int64) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if k == nil || at < 0 || at > 9007199254740991 || age < 1 || age > 300 || at+age > 9007199254740991 || protocol.TextLength(id) < 1 || protocol.TextLength(id) > 128 || !proofKID.MatchString(k.KID) {
		return "", fault.New("signing_unavailable", 503)
	}
	raw, err := protocol.Encode(data)
	var object map[string]json.RawMessage
	if err != nil || json.Unmarshal(raw, &object) != nil || object == nil {
		return "", fault.New("signing_unavailable", 503)
	}
	return k.signEnvelope(kind, data, id, at, age)
}

type PeerEnvelope struct {
	Data                json.RawMessage
	ID                  string
	IssuedAt, ExpiresAt int64
}

// VerifyIdentityGroupSignature covers only the original group control proof,
// not session, Consent or an arbitrary caller-selected JWS purpose.
func VerifyIdentityGroupSignature(token, payload, publicKey string) error {
	return verifyTypedResponse(token, payload, publicKey, "galaxy-identity-group-v2+jws")
}

// VerifyPeerEnvelope uses only the selected agreement's explicit endpoint and
// pins. It does not consult or add to this installation's credential keyring.
func VerifyPeerEnvelope(ctx context.Context, token, kind, endpoint string, pins map[string]Pin, at, maxAge int64) (PeerEnvelope, error) {
	if err := ctx.Err(); err != nil {
		return PeerEnvelope{}, err
	}
	limit := int64(300)
	if kind == "proof" {
		limit = 86400
	} else if kind != "hub-peering" {
		return PeerEnvelope{}, fault.New("signing_purpose_denied", 403)
	}
	if at < 0 || at > 9007199254740991 || maxAge < 1 || maxAge > limit || endpoint == "" || len(pins) == 0 {
		return PeerEnvelope{}, denied()
	}
	verifier := &SessionKeyring{Endpoint: endpoint, Pins: func() map[string]Pin { return pins }}
	v, err := verifier.verifyEnvelope(token, kind, maxAge, at)
	if err != nil {
		return PeerEnvelope{}, err
	}
	return PeerEnvelope{Data: append(json.RawMessage(nil), v.Data...), ID: v.ID, IssuedAt: v.IssuedAt, ExpiresAt: v.ExpiresAt}, nil
}
