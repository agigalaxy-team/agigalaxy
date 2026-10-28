package trustpackages

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
)

func one(v any, values ...string) bool {
	for _, s := range values {
		if v == s {
			return true
		}
	}
	return false
}
func identityDocument(v any) bool {
	o := object(v)
	if !exact(o, []string{"subjectId", "genesisProof", "events", "authority", "checkedAt"}, nil) || !subjectPattern.MatchString(str(o, "subjectId")) || o["authority"] != nil && !origin(o["authority"]) || !integer(o["checkedAt"], 0) {
		return false
	}
	p := object(o["genesisProof"])
	if !exact(p, []string{"version", "publicKeyPem", "nonce"}, nil) || !integer(p["version"], 1) || number(p["version"]) != 1 || !boundedText(p["publicKeyPem"], 0, 256) || !boundedText(p["nonce"], 0, 100) {
		return false
	}
	events, ok := o["events"].([]any)
	if !ok || len(events) > 10000 {
		return false
	}
	for _, v := range events {
		if object(v) == nil {
			return false
		}
	}
	return true
}
func permissionProof(v any) bool {
	o := object(v)
	return exact(o, []string{"signed", "identity", "status", "checkedAt"}, nil) && boundedText(o["signed"], 0, 30000) && identityDocument(o["identity"]) && one(o["status"], "active", "revoked", "expired", "unknown") && integer(o["checkedAt"], 0)
}
func limitations(v any) bool {
	a, ok := v.([]any)
	if !ok || len(a) > 16 {
		return false
	}
	for _, v := range a {
		if !boundedText(v, 0, 500) {
			return false
		}
	}
	return true
}
func sourceSnapshot(v any) bool {
	o := object(v)
	if o["profile"] == "galaxy-ci-proof-v2-reference/1" {
		ref := object(o["ref"])
		return exact(o, []string{"profile", "ref", "issuer", "associatedSubjectId", "sourceHash", "sourceSignatureHash", "sourceExpiresAt", "authority", "sourceState", "checkedAt", "mode", "signatureEvidence", "referenceBasis", "limitations"}, nil) && sourceRef(ref) && ref["kind"] == "ci-proof-v2" && number(ref["version"]) == 1 && ref["caseId"] == nil && ref["taskId"] == nil && origin(o["issuer"]) && o["issuer"] == ref["endpoint"] && subjectPattern.MatchString(str(o, "associatedSubjectId")) && hashPattern.MatchString(str(o, "sourceHash")) && hashPattern.MatchString(str(o, "sourceSignatureHash")) && integer(o["sourceExpiresAt"], 0) && integer(o["checkedAt"], 0) && number(o["sourceExpiresAt"]) > number(o["checkedAt"]) && o["authority"] == "ci-observation" && o["sourceState"] == "current" && o["mode"] == "reference" && o["signatureEvidence"] == "not-provided" && o["referenceBasis"] == "associated-subject-reference" && limitations(o["limitations"])
	}
	if !exact(o, []string{"ref", "authorId", "sourceHash", "authority", "sourceState", "checkedAt", "mode", "signatureEvidence", "referenceBasis", "limitations"}, []string{"bodyText", "permission", "originalSignature"}) || !sourceRef(o["ref"]) || !subjectPattern.MatchString(str(o, "authorId")) || !hashPattern.MatchString(str(o, "sourceHash")) || !one(o["authority"], "participant-reported", "self-asserted", "verification-record", "ci-observation") || !one(o["sourceState"], "current", "superseded", "expired", "revoked", "unavailable", "unknown") || !integer(o["checkedAt"], 0) || !one(o["mode"], "reference", "copy") || !one(o["signatureEvidence"], "original-signature", "legacy-verified-record", "not-provided") || !one(o["referenceBasis"], "own-authored-reference", "public-reference", "explicit-trust-permission") || !limitations(o["limitations"]) {
		return false
	}
	if v, ok := o["bodyText"]; ok && !boundedText(v, 0, 48000) {
		return false
	}
	if v, ok := o["permission"]; ok && !permissionProof(v) {
		return false
	}
	if v, ok := o["originalSignature"]; ok {
		s := object(v)
		if !exact(s, []string{"profile", "signed"}, []string{"identity", "issuer", "keyId"}) || !one(s["profile"], "galaxy-consent", "galaxy-proof", "unrecognized") || !boundedText(s["signed"], 0, 48000) {
			return false
		}
		if v, ok := s["identity"]; ok && !identityDocument(v) {
			return false
		}
		if v, ok := s["issuer"]; ok && !origin(v) {
			return false
		}
		if v, ok := s["keyId"]; ok && !boundedText(v, 0, 160) {
			return false
		}
	}
	return true
}
func ParsePortableInput(in Object) (Object, error) {
	bad := func() (Object, error) { return nil, fail("invalid_trust_input", 422) }
	if !exact(in, []string{"identity", "keyId", "epoch", "audience", "issuedAt", "expiresAt", "claims", "sources"}, nil) || !identityDocument(in["identity"]) || !hashPattern.MatchString(str(in, "keyId")) || !integer(in["epoch"], 0) || !audience(in["audience"]) || !integer(in["issuedAt"], 0) || !integer(in["expiresAt"], 0) || number(in["expiresAt"]) <= number(in["issuedAt"]) || number(in["expiresAt"])-number(in["issuedAt"]) > 30*86400 {
		return bad()
	}
	claims, ok := in["claims"].([]any)
	if !ok || len(claims) > 50 {
		return bad()
	}
	sources, ok := in["sources"].([]any)
	if !ok || len(sources) > 50 || len(claims)+len(sources) == 0 {
		return bad()
	}
	out := Object{}
	for k, v := range in {
		out[k] = v
	}
	parsedClaims := []any{}
	for _, v := range claims {
		c := object(v)
		if !exact(c, []string{"id", "text", "authority", "capabilityVerified"}, nil) || !uuidPattern.MatchString(str(c, "id")) || c["authority"] != "self-asserted" || c["capabilityVerified"] != false {
			return bad()
		}
		text := c["text"]
		var units jstext.String
		switch v := text.(type) {
		case string:
			units = jstext.From(v)
		case jstext.String:
			units = v
		default:
			return bad()
		}
		units = units.Trim()
		if units.CodePointLen() < 1 || units.CodePointLen() > 4000 {
			return bad()
		}
		parsed := Object{}
		for k, v := range c {
			parsed[k] = v
		}
		if units.HasUnpaired() {
			parsed["text"] = units
		} else {
			parsed["text"] = units.Decoded()
		}
		parsedClaims = append(parsedClaims, parsed)
	}
	out["claims"] = parsedClaims
	for _, v := range sources {
		s := object(v)
		if !sourceSnapshot(s) {
			return bad()
		}
		if s["profile"] == "galaxy-ci-proof-v2-reference/1" && (s["associatedSubjectId"] != object(in["identity"])["subjectId"] || number(in["expiresAt"]) > number(s["sourceExpiresAt"])) {
			return bad()
		}
	}
	return out, nil
}
func parseManifest(o Object) error {
	if !exact(o, []string{"version", "type", "packageId", "subjectId", "keyId", "epoch", "chainHead", "audience", "issuedAt", "expiresAt", "files", "integrityMeaning", "onlineCurrentState", "timestampAuthority"}, nil) || number(o["version"]) != 1 || !integer(o["version"], 1) || o["type"] != "galaxy-readable-trust" || !hashPattern.MatchString(str(o, "packageId")) || !subjectPattern.MatchString(str(o, "subjectId")) || !hashPattern.MatchString(str(o, "keyId")) || !integer(o["epoch"], 0) || o["chainHead"] != nil && !hashPattern.MatchString(str(o, "chainHead")) || !audience(o["audience"]) || !integer(o["issuedAt"], 0) || !integer(o["expiresAt"], 0) || o["integrityMeaning"] != "package-signature-does-not-certify-contained-claims" || o["onlineCurrentState"] != "not-checked" || o["timestampAuthority"] != "signer-declared-time" {
		return fail("invalid_trust_manifest", 422)
	}
	a, ok := o["files"].([]any)
	if !ok || len(a) != 3 {
		return fail("invalid_trust_manifest", 422)
	}
	for _, v := range a {
		r := object(v)
		if !exact(r, []string{"path", "sha256", "bytes"}, nil) || !one(r["path"], "summary.md", "objects.json", "identity.json") || !hashPattern.MatchString(str(r, "sha256")) || !integer(r["bytes"], 0) || number(r["bytes"]) > 2000000 {
			return fail("invalid_trust_manifest", 422)
		}
	}
	return nil
}
func parseContainer(o Object) error {
	if !exact(o, []string{"format", "files", "manifestJson", "signature"}, nil) || o["format"] != "galaxy-readable-trust/v1" || !boundedText(o["manifestJson"], 0, 20000) || !boundedText(o["signature"], 0, 40000) {
		return fail("invalid_trust_container", 422)
	}
	files := object(o["files"])
	if !exact(files, []string{"summary.md", "objects.json", "identity.json"}, nil) || !boundedText(files["summary.md"], 0, 500000) || !boundedText(files["objects.json"], 0, 2000000) || !boundedText(files["identity.json"], 0, 2000000) {
		return fail("invalid_trust_container", 422)
	}
	return nil
}
