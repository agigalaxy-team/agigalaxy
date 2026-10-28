package trustpackages

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// VerifyPortableIdentity checks only the included original history. It never
// supplies a live service credential or claims current remote revocation.
func VerifyPortableIdentity(input Object) (Object, error) {
	raw, e := protocol.EncodeJS(input)
	if e != nil {
		return nil, e
	}
	proof := object(input["genesisProof"])
	events := array(input["events"])
	subject := str(input, "subjectId")
	if len(events) == 0 {
		rawProof, e := protocol.EncodeJS(proof)
		if e != nil {
			return nil, e
		}
		if !identity.VerifyPortableGenesis(subject, rawProof) {
			return nil, fail("trust_identity_invalid", 422)
		}
		public := str(proof, "publicKeyPem")
		return Object{"subjectId": subject, "epoch": 0, "sequence": 0, "chainHead": nil, "devices": []any{Object{"keyId": identity.Digest([]byte(public)), "publicKey": public, "deviceId": nil, "scopes": []any{"*"}, "epoch": 0}}, "historySignaturesVerified": true, "currentRevocationChecked": false}, nil
	}
	state, e := identity.VerifyControlChain(raw)
	if e != nil {
		return nil, e
	}
	devices := []any{}
	for _, d := range state.Devices {
		devices = append(devices, Object{"keyId": d.KeyID, "publicKey": d.PublicKey, "deviceId": d.DeviceID, "scopes": d.Scopes, "epoch": d.Epoch})
	}
	return Object{"subjectId": state.SubjectID, "epoch": state.Epoch, "sequence": state.Sequence, "chainHead": state.ChainHead, "devices": devices, "historySignaturesVerified": true, "currentRevocationChecked": false}, nil
}
func portableSigner(control Object, keyID string, epoch int64) (Object, error) {
	for _, v := range array(control["devices"]) {
		key := object(v)
		if key["keyId"] != keyID || number(key["epoch"]) != epoch {
			continue
		}
		scopes := []string{}
		switch values := key["scopes"].(type) {
		case []any:
			for _, v := range values {
				s, _ := v.(string)
				scopes = append(scopes, s)
			}
		case []string:
			scopes = values
		}
		for _, scope := range scopes {
			if scope == "*" || scope == "consent" || scope == "manage-identity" {
				return key, nil
			}
		}
	}
	return nil, fail("trust_signer_unavailable", 422)
}
func VerifyPermissionProof(proof, source Object, holder string, audience Object, now, expiresAt int64) (Object, error) {
	control, e := VerifyPortableIdentity(object(proof["identity"]))
	if e != nil {
		return nil, e
	}
	identityDoc := object(proof["identity"])
	var grant Object
	token := str(proof, "signed")
	for _, v := range array(control["devices"]) {
		candidate := object(v)
		payload, e := deviceauth.VerifyTrustPermissionResponse(token, str(candidate, "publicKey"))
		if e != nil {
			continue
		}
		value, e := decodeObject([]byte(payload))
		if e != nil {
			continue
		}
		parsed, e := ParsePermission(value)
		if e != nil {
			continue
		}
		key, e := portableSigner(control, str(parsed, "keyId"), number(parsed["epoch"]))
		if e != nil || key["keyId"] != candidate["keyId"] {
			continue
		}
		grant = parsed
		break
	}
	if grant == nil {
		return nil, fail("trust_permission_signature_invalid", 422)
	}
	var originalHash any
	if original := object(source["originalSignature"]); original != nil {
		originalHash = identity.Digest([]byte(str(original, "signed")))
	}
	if grant["kind"] != "grant" || grant["subjectId"] != identityDoc["subjectId"] || grant["subjectId"] != source["authorId"] || grant["grantee"] != holder || !same(grant["chainHead"], control["chainHead"]) || !same(grant["source"], source["ref"]) || grant["sourceHash"] != source["sourceHash"] || !same(grant["originalSignatureHash"], originalHash) || !audienceAllows(object(grant["audience"]), audience) || number(grant["issuedAt"]) > now+300 || number(grant["expiresAt"]) < expiresAt || number(grant["expiresAt"]) <= now || proof["status"] == "revoked" {
		return nil, fail("trust_permission_scope_invalid", 422)
	}
	return Object{"grant": grant, "signatureValid": true, "stateAtObservation": proof["status"], "checkedAt": proof["checkedAt"], "currentRevocationChecked": false, "onlineAccessGranted": false, "thirdPartySourceBodyPermission": false}, nil
}
