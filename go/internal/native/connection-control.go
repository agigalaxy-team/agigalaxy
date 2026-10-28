package native

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/google/uuid"
)

type connectionDevice struct {
	DeviceID  string
	PublicKey string
	KeyID     string
	Scopes    []string
	Epoch     int64
}
type connectionControl struct {
	Epoch, Sequence int64
	Head            any
	Devices         map[string]connectionDevice
}

var connectionSubject = regexp.MustCompile(`^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$`)

func connectionCanonicalPublic(value string) bool {
	key, e := connectionPublicPEM(value)
	if e != nil {
		return false
	}
	canonical, e := identity.PublicPEM(key)
	return e == nil && canonical == value
}

func connectionGenesis(subject string, proof map[string]any) bool {
	if !connectionSubject.MatchString(subject) || integer(proof["version"]) != 1 {
		return false
	}
	public := text(proof["publicKeyPem"])
	if !connectionCanonicalPublic(public) {
		return false
	}
	nonce, e := base64.RawURLEncoding.Strict().DecodeString(text(proof["nonce"]))
	if e != nil || len(nonce) < 16 || len(nonce) > 64 {
		return false
	}
	alphabet := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	issued := int64(0)
	for _, ch := range subject[6:16] {
		issued = issued*32 + int64(strings.IndexRune(alphabet, ch))
	}
	input := append([]byte(fmt.Sprintf("galaxy/guid/v1\x00%s\x00%d\x00%s\x00", subject[5:6], issued, strings.TrimSpace(public))), nonce...)
	digest := identity.Digest(input)
	raw, _ := new(big.Int).SetString(digest[:20], 16)
	suffix := make([]byte, 16)
	mask := big.NewInt(31)
	for i := 15; i >= 0; i-- {
		digit := new(big.Int).And(raw, mask).Int64()
		suffix[i] = alphabet[digit]
		raw.Rsh(raw, 5)
	}
	return string(suffix) == subject[16:]
}
func controlUUID(v any) bool {
	s, ok := v.(string)
	if !ok {
		return false
	}
	u, e := uuid.Parse(s)
	return e == nil && strings.EqualFold(u.String(), s)
}
func connectionIncludes(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func verifyConnectionControl(state map[string]any) (connectionControl, error) {
	out := connectionControl{Devices: map[string]connectionDevice{}}
	subject := text(state["subjectId"])
	proof, _ := state["genesisProof"].(map[string]any)
	if !connectionGenesis(subject, proof) {
		return out, connectionFailure("native_control_genesis_invalid")
	}
	events, ok := state["events"].([]any)
	if !ok || len(events) > 10000 {
		return out, connectionFailure("native_control_history_invalid")
	}
	if len(events) == 0 {
		p := text(proof["publicKeyPem"])
		key := identity.Digest([]byte(p))
		out.Devices[key] = connectionDevice{PublicKey: p, KeyID: key, Scopes: []string{"*"}}
		return out, nil
	}
	raw, e := json.Marshal(state)
	if e != nil {
		return out, e
	}
	verified, e := identity.VerifyControlChain(raw)
	if e != nil {
		if errors.Is(e, identity.ErrControlChainSignatureInvalid) {
			return out, connectionFailure("native_control_signature_invalid")
		}
		return out, connectionFailure("native_control_history_invalid")
	}
	out.Epoch = verified.Epoch
	out.Sequence = verified.Sequence
	out.Head = verified.ChainHead
	for _, d := range verified.Devices {
		out.Devices[d.KeyID] = connectionDevice{DeviceID: d.DeviceID, PublicKey: d.PublicKey, KeyID: d.KeyID, Scopes: d.Scopes, Epoch: d.Epoch}
	}
	return out, nil
}

// JSON round trips here are only for public snapshots, never device key material.
func cloneConnectionMap(v map[string]any) map[string]any {
	b, _ := json.Marshal(v)
	out, _ := connectionObject(b)
	return out
}
