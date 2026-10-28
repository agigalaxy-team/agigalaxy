package identity

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"github.com/google/uuid"
	textunicode "golang.org/x/text/encoding/unicode"
	"io"
	"math"
	"math/big"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// ControlChainState establishes only the included history, never current authority.
type ControlChainState struct {
	SubjectID                 string                `json:"subjectId"`
	Epoch                     int64                 `json:"epoch"`
	Sequence                  int64                 `json:"sequence"`
	ChainHead                 any                   `json:"chainHead"`
	Devices                   []ControlChainDevice  `json:"devices"`
	Recovery                  *ControlChainRecovery `json:"recovery"`
	HistorySignaturesVerified bool                  `json:"historySignaturesVerified"`
	CurrentRevocationChecked  bool                  `json:"currentRevocationChecked"`
}
type ControlChainDevice struct {
	KeyID     string   `json:"keyId"`
	PublicKey string   `json:"publicKey"`
	DeviceID  string   `json:"deviceId"`
	Scopes    []string `json:"scopes"`
	Epoch     int64    `json:"epoch"`
}
type ControlChainRecovery struct {
	PublicKey  string `json:"publicKey"`
	Generation int64  `json:"generation"`
}

// VerifyControlChain verifies the original payload strings and historical signatures without I/O.
func VerifyControlChain(raw []byte) (ControlChainState, error) {
	m, e := connectionObject(raw)
	if e != nil {
		return ControlChainState{}, e
	}
	out, e := verifyControlChain(m)
	if e != nil {
		return ControlChainState{}, e
	}
	return out, nil
}

// ErrControlChainSignatureInvalid preserves the signature failure category for native callers.
var ErrControlChainSignatureInvalid = errors.New("identity_control_chain_signature_invalid")

func chainInvalid() error             { return errors.New("identity_control_chain_invalid") }
func text(v any) string               { s, _ := v.(string); return s }
func integer(v any) int64             { n, _ := v.(json.Number); f, _ := n.Float64(); return int64(f) }
func numberEqual(v any, n int64) bool { return connectionSafeInteger(v) && integer(v) == n }

var connectionHash = regexp.MustCompile(`^[a-f0-9]{64}$`)
var connectionSubject = regexp.MustCompile(`^GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$`)
var connectionScope = regexp.MustCompile(`^(?:[a-z][a-z0-9:-]{0,63}|\*)$`)

func connectionCanonicalPublic(value string) bool {
	key, e := connectionPublicPEM(value)
	if e != nil {
		return false
	}
	canonical, e := PublicPEM(key)
	return e == nil && canonical == value
}

func connectionGenesis(subject string, proof map[string]any) bool {
	if !connectionSubject.MatchString(subject) || !numberEqual(proof["version"], 1) || !connectionExact(proof, "version", "publicKeyPem", "nonce") {
		return false
	}
	public := text(proof["publicKeyPem"])
	if len(public) > 256 || !connectionCanonicalPublic(public) {
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
	digest := Digest(input)
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
func connectionNewDevice(v any) (ControlChainDevice, error) {
	m, ok := v.(map[string]any)
	if !ok || !connectionExact(m, "deviceId", "publicKeyPem", "scopes") || !controlUUID(m["deviceId"]) {
		return ControlChainDevice{}, chainInvalid()
	}
	public := text(m["publicKeyPem"])
	if len(public) > 256 || !connectionCanonicalPublic(public) {
		return ControlChainDevice{}, chainInvalid()
	}
	scopes, ok := connectionStrings(m["scopes"])
	if !ok || len(scopes) < 1 || len(scopes) > 64 {
		return ControlChainDevice{}, chainInvalid()
	}
	seen := map[string]bool{}
	for _, scope := range scopes {
		if !connectionScope.MatchString(scope) || seen[scope] {
			return ControlChainDevice{}, chainInvalid()
		}
		seen[scope] = true
	}
	return ControlChainDevice{DeviceID: text(m["deviceId"]), PublicKey: public, KeyID: Digest([]byte(public)), Scopes: scopes}, nil
}
func connectionIncludes(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func verifyControlChain(state map[string]any) (ControlChainState, error) {
	out := ControlChainState{SubjectID: text(state["subjectId"]), HistorySignaturesVerified: true, Devices: []ControlChainDevice{}}
	devices := map[string]ControlChainDevice{}
	order := []string{}
	subject := text(state["subjectId"])
	proof, _ := state["genesisProof"].(map[string]any)
	if !connectionGenesis(subject, proof) {
		return out, chainInvalid()
	}
	events, ok := state["events"].([]any)
	if !ok || len(events) > 10000 {
		return out, chainInvalid()
	}
	if len(events) == 0 {
		return out, chainInvalid()
	}
	usedDevices := map[string]bool{}
	usedRecovery := map[string]bool{}
	recoveryPublic := ""
	recoveryGeneration := int64(0)
	for _, raw := range events {
		row, ok := raw.(map[string]any)
		if !ok {
			return out, chainInvalid()
		}
		accepted, e := controlAcceptedAt(row["accepted_at"])
		if e != nil {
			return out, e
		}
		event := map[string]any{"id": row["id"], "subjectId": row["subject_id"], "sequence": row["sequence"], "epoch": row["epoch"], "kind": row["kind"], "previousEventHash": row["previous_event_hash"], "payloadText": row["payload_text"], "controllerSignature": row["controller_signature"], "newDeviceProof": row["new_device_proof"], "signerKeyId": row["signer_key_id"], "acceptedAt": accepted}
		envelope, e := connectionObject([]byte(text(row["payload_text"])))
		if e != nil {
			return out, e
		}
		request, ok := envelope["request"].(map[string]any)
		if !ok {
			return out, chainInvalid()
		}
		kind := text(request["kind"])
		fields := []string{"operationId", "subjectId", "expectedEpoch", "previousEventHash", "signerKeyId", "kind"}
		if _, ok := request["version"]; ok {
			fields = append(fields, "version")
			if !numberEqual(request["version"], 2) {
				return out, chainInvalid()
			}
		}
		switch kind {
		case "bootstrap":
			fields = append(fields, "genesisProof", "newDevice")
		case "authorize-device":
			fields = append(fields, "newDevice")
		case "revoke-device":
			fields = append(fields, "deviceId")
			if !controlUUID(request["deviceId"]) {
				return out, chainInvalid()
			}
		case "set-recovery":
			if !connectionSafeInteger(request["recoveryGeneration"]) || !connectionCanonicalPublic(text(request["nextRecoveryPublicKey"])) || len(text(request["nextRecoveryPublicKey"])) > 256 {
				return out, chainInvalid()
			}
			fields = append(fields, "recoveryGeneration", "nextRecoveryPublicKey", "saveDeclaration")
			if request["saveDeclaration"] != true {
				return out, chainInvalid()
			}
		case "recover":
			if !connectionSafeInteger(request["recoveryGeneration"]) || integer(request["recoveryGeneration"]) < 1 || !connectionCanonicalPublic(text(request["nextRecoveryPublicKey"])) || len(text(request["nextRecoveryPublicKey"])) > 256 {
				return out, chainInvalid()
			}
			fields = append(fields, "recoveryGeneration", "newDevice", "nextRecoveryPublicKey")
		case "declare-recovery-saved":
			fields = append(fields, "recoveryGeneration", "saveDeclaration")
			if request["saveDeclaration"] != true || !connectionSafeInteger(request["recoveryGeneration"]) || integer(request["recoveryGeneration"]) < 1 {
				return out, chainInvalid()
			}
		default:
			return out, chainInvalid()
		}
		if !connectionExact(request, fields...) || !controlUUID(request["operationId"]) || !connectionHash.MatchString(text(request["signerKeyId"])) || !connectionSafeInteger(request["expectedEpoch"]) || integer(request["expectedEpoch"]) != out.Epoch || request["previousEventHash"] != out.ChainHead || row["previous_event_hash"] != out.ChainHead || request["subjectId"] != subject || row["subject_id"] != subject || row["id"] != request["operationId"] || row["kind"] != kind || (!connectionSafeInteger(row["sequence"]) || integer(row["sequence"]) != out.Sequence+1) || !numberEqual(envelope["version"], 2) || envelope["type"] != "identity-control" || !controlTruthy(envelope["audience"]) {
			return out, chainInvalid()
		}
		hash, e := connectionCanonicalHash(event)
		if e != nil || hash != row["event_hash"] {
			return out, chainInvalid()
		}
		var signer ControlChainDevice
		switch kind {
		case "bootstrap":
			genesis, _ := request["genesisProof"].(map[string]any)
			newDevice, _ := request["newDevice"].(map[string]any)
			if out.Sequence != 0 || !connectionGenesis(subject, genesis) || genesis["nonce"] != proof["nonce"] || genesis["publicKeyPem"] != proof["publicKeyPem"] || newDevice["publicKeyPem"] != proof["publicKeyPem"] {
				return out, chainInvalid()
			}
			signer = ControlChainDevice{PublicKey: text(proof["publicKeyPem"]), Scopes: []string{"*"}}
			out.Epoch = 1
		case "recover":
			if recoveryPublic == "" || integer(request["recoveryGeneration"]) != recoveryGeneration || !connectionSafeInteger(request["recoveryGeneration"]) {
				return out, chainInvalid()
			}
			signer = ControlChainDevice{PublicKey: recoveryPublic, Scopes: []string{"*"}}
		default:
			var exists bool
			signer, exists = devices[text(request["signerKeyId"])]
			if !exists || !connectionIncludes(signer.Scopes, "manage-identity") {
				return out, chainInvalid()
			}
		}
		if Digest([]byte(signer.PublicKey)) != request["signerKeyId"] || row["signer_key_id"] != request["signerKeyId"] {
			return out, chainInvalid()
		}
		if e = connectionVerifyJWS(text(row["controller_signature"]), signer.PublicKey, text(row["payload_text"]), "galaxy-identity-control-v2+jws"); e != nil {
			return out, e
		}
		if kind == "recover" {
			out.Epoch++
			devices = map[string]ControlChainDevice{}
			order = nil
		}
		if !connectionSafeInteger(row["epoch"]) || integer(row["epoch"]) != out.Epoch {
			return out, chainInvalid()
		}
		if v, ok := request["newDevice"]; ok {
			device, e := connectionNewDevice(v)
			if e != nil {
				return out, e
			}
			if e = connectionVerifyJWS(text(row["new_device_proof"]), device.PublicKey, text(row["payload_text"]), "galaxy-identity-control-v2+jws"); e != nil {
				return out, e
			}
			if (kind == "bootstrap" || kind == "recover") && !connectionIncludes(device.Scopes, "manage-identity") || kind != "bootstrap" && connectionIncludes(device.Scopes, "*") || usedDevices[device.DeviceID] {
				return out, chainInvalid()
			}
			if _, ok = devices[device.KeyID]; ok {
				return out, chainInvalid()
			}
			for _, scope := range device.Scopes {
				if !connectionIncludes(signer.Scopes, "*") && !connectionIncludes(signer.Scopes, scope) {
					return out, chainInvalid()
				}
			}
			usedDevices[device.DeviceID] = true
			device.Epoch = out.Epoch
			devices[device.KeyID] = device
			order = append(order, device.KeyID)
		}
		if kind == "revoke-device" {
			found := false
			for key, device := range devices {
				if device.DeviceID == text(request["deviceId"]) {
					delete(devices, key)
					for i, k := range order {
						if k == key {
							order = append(order[:i], order[i+1:]...)
							break
						}
					}
					found = true
					break
				}
			}
			manager := false
			for _, device := range devices {
				manager = manager || connectionIncludes(device.Scopes, "manage-identity")
			}
			if !found || recoveryPublic == "" && !manager {
				return out, chainInvalid()
			}
		}
		if next := text(request["nextRecoveryPublicKey"]); next != "" {
			if !connectionCanonicalPublic(next) {
				return out, chainInvalid()
			}
			newDevice, _ := request["newDevice"].(map[string]any)
			if !connectionSafeInteger(request["recoveryGeneration"]) || integer(request["recoveryGeneration"]) != recoveryGeneration || usedRecovery[next] || next == signer.PublicKey || next == newDevice["publicKeyPem"] {
				return out, chainInvalid()
			}
			recoveryPublic = next
			recoveryGeneration++
			usedRecovery[next] = true
		}
		if kind == "declare-recovery-saved" && (!connectionSafeInteger(request["recoveryGeneration"]) || integer(request["recoveryGeneration"]) != recoveryGeneration) {
			return out, chainInvalid()
		}
		out.Sequence++
		out.ChainHead = row["event_hash"]
	}
	for _, key := range order {
		if d, ok := devices[key]; ok {
			out.Devices = append(out.Devices, d)
		}
	}
	if recoveryPublic != "" {
		out.Recovery = &ControlChainRecovery{recoveryPublic, recoveryGeneration}
	}
	return out, nil
}

func connectionExact(v map[string]any, keys ...string) bool {
	if v == nil || len(v) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := v[key]; !ok {
			return false
		}
	}
	return true
}
func connectionStrings(v any) ([]string, bool) {
	a, ok := v.([]any)
	if !ok {
		return nil, false
	}
	out := make([]string, len(a))
	for i, v := range a {
		s, ok := v.(string)
		if !ok {
			return nil, false
		}
		out[i] = s
	}
	return out, true
}
func connectionSafeInteger(v any) bool {
	n, ok := v.(json.Number)
	if !ok {
		return false
	}
	f, e := n.Float64()
	return e == nil && f >= 0 && f <= 9007199254740991 && math.Trunc(f) == f
}
func connectionISO(value string) (string, error) {
	t, e := time.Parse(time.RFC3339Nano, value)
	if e != nil {
		return "", chainInvalid()
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z"), nil
}
func connectionObject(raw []byte) (map[string]any, error) {
	if !utf8.Valid(raw) {
		return nil, chainInvalid()
	}
	var out map[string]any
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if e := d.Decode(&out); e != nil || out == nil {
		return nil, chainInvalid()
	}
	var tail any
	if d.Decode(&tail) != io.EOF {
		return nil, chainInvalid()
	}
	return out, nil
}
func connectionCanonicalHash(v any) (string, error) {
	raw, e := Canonical(v)
	if e != nil {
		return "", e
	}
	return Digest(raw), nil
}

func connectionVerifyJWS(token, pemText, payloadText, kind string) error {
	return verifyHistoricalSignature(token, pemText, payloadText, kind, 24000)
}
func verifyHistoricalSignature(token, pemText, payloadText, kind string, maxLength int) error {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || maxLength > 0 && len(token) > maxLength {
		return ErrControlChainSignatureInvalid
	}
	h, e := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if e != nil {
		return ErrControlChainSignatureInvalid
	}
	header, e := connectionObject(h)
	if e != nil || !connectionExact(header, "alg", "typ") || header["alg"] != "Ed25519" || header["typ"] != kind {
		return ErrControlChainSignatureInvalid
	}
	body, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil || string(body) != payloadText {
		return ErrControlChainSignatureInvalid
	}
	return verifyHistoricalInput(parts, pemText)
}

// Signature bytes and public-key parsing remain shared by the fixed purposes.
func verifyHistoricalInput(parts []string, pemText string) error {
	signature, e := base64.RawURLEncoding.Strict().DecodeString(parts[2])
	key, keyError := connectionPublicPEM(pemText)
	if e != nil || keyError != nil || !ed25519.Verify(key, []byte(parts[0]+"."+parts[1]), signature) {
		return ErrControlChainSignatureInvalid
	}
	return nil
}

func connectionPublicPEM(s string) (ed25519.PublicKey, error) {
	b, rest := pem.Decode([]byte(s))
	if b == nil || b.Type != "PUBLIC KEY" || len(rest) > 0 {
		return nil, chainInvalid()
	}
	v, e := x509.ParsePKIXPublicKey(b.Bytes)
	if e != nil {
		return nil, chainInvalid()
	}
	k, ok := v.(ed25519.PublicKey)
	if !ok {
		return nil, chainInvalid()
	}
	return k, nil
}

func controlTruthy(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		f, _ := x.Float64()
		return f != 0 && !math.IsNaN(f)
	default:
		return true
	}
}
func controlAcceptedAt(v any) (string, error) {
	switch x := v.(type) {
	case string:
		if t, e := time.Parse("2006-01-02", x); e == nil {
			return t.UTC().Format("2006-01-02T15:04:05.000Z"), nil
		}
		return connectionISO(x)
	case json.Number:
		f, e := x.Float64()
		if e != nil || math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > 8640000000000000 {
			return "", chainInvalid()
		}
		return time.UnixMilli(int64(f)).UTC().Format("2006-01-02T15:04:05.000Z"), nil
	case nil:
		return time.UnixMilli(0).UTC().Format("2006-01-02T15:04:05.000Z"), nil
	case bool:
		n := int64(0)
		if x {
			n = 1
		}
		return time.UnixMilli(n).UTC().Format("2006-01-02T15:04:05.000Z"), nil
	default:
		return "", chainInvalid()
	}
}

// VerifyPortableGenesis is the original portable legacy proof check; it does not grant access.
func VerifyPortableGenesis(subject string, raw []byte) bool {
	proof, e := connectionObject(raw)
	return e == nil && connectionGenesis(subject, proof)
}

// VerifyTrustPackageSignature checks only the fixed portable package signature purpose.
func VerifyTrustPackageSignature(token, publicKey, payload string) error {
	if !utf8.ValidString(payload) {
		return ErrControlChainSignatureInvalid
	}
	return verifyHistoricalSignature(token, publicKey, payload, "galaxy-trust-package-v1+jws", 0)
}

// OpenTrustConsentSignature returns original signed text for the fixed inner Consent purpose.
func OpenTrustConsentSignature(token, publicKey string) (string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", ErrControlChainSignatureInvalid
	}
	b, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil || !utf8.Valid(b) {
		return "", ErrControlChainSignatureInvalid
	}
	payload := string(b)
	if e = verifyHistoricalSignature(token, publicKey, payload, "galaxy-consent+jws", 0); e != nil {
		return "", e
	}
	return payload, nil
}

// VerifyTrustVCSignature verifies only the original fixed VC envelope profile.
// The caller retains the selected pin, canonical document, audience and time policy.
func VerifyTrustVCSignature(token, publicKey string) (payload, kid string, err error) {
	return openTrustProfile(token, publicKey, true)
}

// VerifyTrustProofSignature is only the optional inner galaxy-proof profile;
// it does not apply current-session JWT expiry or assert current revocation.
func VerifyTrustProofSignature(token, publicKey string) (payload, kid string, err error) {
	return openTrustProfile(token, publicKey, false)
}
func openTrustProfile(token, publicKey string, vc bool) (string, string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return "", "", ErrControlChainSignatureInvalid
	}
	headerBytes, e := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if e != nil || !utf8.Valid(headerBytes) {
		return "", "", ErrControlChainSignatureInvalid
	}
	headerBytes = bytes.TrimPrefix(headerBytes, []byte{0xef, 0xbb, 0xbf})
	header, e := connectionObject(headerBytes)
	if e != nil || header["alg"] != "Ed25519" {
		return "", "", ErrControlChainSignatureInvalid
	}
	kid, ok := header["kid"].(string)
	if !ok {
		return "", "", ErrControlChainSignatureInvalid
	}
	if vc {
		if !connectionExact(header, "alg", "cty", "kid", "typ") || header["typ"] != "vc+jwt" || header["cty"] != "vc" || !connectionHash.MatchString(kid) {
			return "", "", ErrControlChainSignatureInvalid
		}
	} else if !connectionExact(header, "alg", "kid", "typ") || header["typ"] != "galaxy-proof+jwt" {
		return "", "", ErrControlChainSignatureInvalid
	}
	body, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if e != nil || vc && !utf8.Valid(body) {
		return "", "", ErrControlChainSignatureInvalid
	}
	if e = verifyHistoricalInput(parts, publicKey); e != nil {
		return "", "", e
	}
	decoded, e := textunicode.UTF8BOM.NewDecoder().Bytes(body)
	if e != nil {
		return "", "", ErrControlChainSignatureInvalid
	}
	return string(decoded), kid, nil
}
