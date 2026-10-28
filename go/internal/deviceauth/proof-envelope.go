package deviceauth

import (
	"context"
	"encoding/json"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

var proofKID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)

// SignProof is the original proof-purpose envelope only. The proof domain must
// validate the full statement, observation deadline and current source before
// invoking it; this method supplies no evidence visibility or publish authority.
func (k *SessionKeyring) SignProof(ctx context.Context, data any, id string, at, age int64) (string, error) {
	if at < 0 || at > 9007199254740991 || age < 1 || age > 86400 || at+age > 9007199254740991 || protocol.TextLength(id) < 1 || protocol.TextLength(id) > 128 || !proofKID.MatchString(k.KID) {
		return "", fault.New("signing_unavailable", 503)
	}
	raw, e := protocol.Encode(data)
	var object map[string]json.RawMessage
	if e != nil || json.Unmarshal(raw, &object) != nil || object == nil {
		return "", fault.New("signing_unavailable", 503)
	}
	return k.signEnvelope("proof", data, id, at, age)
}

// VerifyProof returns the original signed data bytes and expiry. Revocation,
// CI observation freshness, Consent and proof visibility remain domain checks.
func (k *SessionKeyring) VerifyProof(ctx context.Context, token string, at int64) (json.RawMessage, int64, error) {
	if at < 0 || at > 9007199254740991 {
		return nil, 0, denied()
	}
	v, e := k.verifyEnvelope(token, "proof", 86400, at)
	if e != nil {
		return nil, 0, e
	}
	return append(json.RawMessage(nil), v.Data...), v.ExpiresAt, nil
}
