package trustpackages

import (
	"crypto/sha512"
	"encoding/base64"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

const VCProfile = "galaxy-trust-vc-jose/v1"
const VCMediaType = "application/vc+jwt"
const vcContext = "https://www.w3.org/ns/credentials/v2"

type VCIssuerPin struct {
	PublicKeyPEM        string
	Revoked             bool
	NotBefore, NotAfter *int64
}
type VCVerifyOptions struct {
	Now                                       int64
	TrustedIssuers                            map[string]map[string]VCIssuerPin
	ExpectedIssuer, ExpectedSubject, Audience *string
}

func SubjectURI(subject string) (string, error) {
	if !subjectPattern.MatchString(subject) {
		return "", fail("invalid_trust_subject", 422)
	}
	return "urn:galaxy:subject:" + subject, nil
}
func vcSeconds(n int64) bool { return n >= 0 && n <= 8640000000000 }
func vcResource(container Object) (Object, error) {
	text, e := canonical(container)
	if e != nil {
		return nil, e
	}
	sum := sha512.Sum384([]byte(text))
	return Object{"id": "urn:sha256:" + identity.Digest([]byte(text)), "mediaType": "application/json", "digestSRI": "sha384-" + base64.StdEncoding.EncodeToString(sum[:])}, nil
}
func vcPackageDetails(container Object, now int64) (manifest, result, key Object, e error) {
	if e = parseContainer(container); e != nil {
		return
	}
	result, e = Verify(container, VerifyOptions{Now: now})
	if e != nil {
		return
	}
	manifest, e = decodeObject([]byte(str(container, "manifestJson")))
	if e != nil {
		return
	}
	if e = parseManifest(manifest); e != nil {
		return
	}
	id, er := decodeObject([]byte(wireString(object(container["files"])["identity.json"])))
	if er != nil {
		e = er
		return
	}
	control, er := VerifyPortableIdentity(id)
	if er != nil {
		e = er
		return
	}
	for _, v := range array(control["devices"]) {
		candidate := object(v)
		if candidate["keyId"] == manifest["keyId"] && number(candidate["epoch"]) == number(manifest["epoch"]) {
			key = candidate
			return
		}
	}
	e = fail("trust_vc_signer_mismatch", 422)
	return
}
func credentialFor(manifest Object, summary any, resource Object, issuedAt int64) (Object, error) {
	issuer, e := SubjectURI(str(manifest, "subjectId"))
	if e != nil {
		return nil, e
	}
	if !vcSeconds(number(manifest["issuedAt"])) || !vcSeconds(number(manifest["expiresAt"])) {
		return nil, fail("trust_vc_time_invalid", 422)
	}
	credential := Object{"@context": []any{vcContext}, "type": []any{"VerifiableCredential"}, "id": "urn:galaxy:trust-package:" + str(manifest, "packageId") + ":vc-jose:" + intText(issuedAt), "issuer": issuer, "credentialSubject": Object{"id": issuer, "description": summary}, "name": "Self-issued attestation of a selected Galaxy trust package", "description": "The identified subject signs this selected package. This does not certify its contained claims, institutional authority, capability, current permission, or current revocation status.", "validFrom": date(manifest["issuedAt"]), "validUntil": date(manifest["expiresAt"]), "relatedResource": []any{resource}, "iss": issuer, "sub": issuer, "iat": issuedAt, "exp": manifest["expiresAt"]}
	if audience := object(manifest["audience"]); audience["kind"] == "subjects" {
		aud := []any{}
		for _, v := range array(audience["subjectIds"]) {
			uri, e := SubjectURI(wireString(v))
			if e != nil {
				return nil, e
			}
			aud = append(aud, uri)
		}
		credential["aud"] = aud
	}
	return credential, nil
}
func intText(n int64) string { raw, _ := protocol.EncodeJS(n); return string(raw) }

func PrepareVC(container Object, now int64) (Object, error) {
	if !vcSeconds(now) {
		return nil, fail("trust_vc_time_invalid", 422)
	}
	manifest, result, _, e := vcPackageDetails(container, now)
	if e != nil {
		return nil, e
	}
	if number(manifest["issuedAt"]) > now || number(manifest["expiresAt"]) <= now {
		return nil, fail("trust_vc_package_not_current", 422)
	}
	for _, v := range array(result["sources"]) {
		if object(object(v)["reproductionPermission"])["status"] == "invalid-or-expired" {
			return nil, fail("trust_vc_reproduction_permission_unavailable", 422)
		}
	}
	resource, e := vcResource(container)
	if e != nil {
		return nil, e
	}
	credential, e := credentialFor(manifest, object(container["files"])["summary.md"], resource, now)
	if e != nil {
		return nil, e
	}
	text, e := canonical(credential)
	if e != nil {
		return nil, e
	}
	return Object{"profile": VCProfile, "mediaType": VCMediaType, "package": container, "credential": credential, "payloadJson": text, "protectedHeader": Object{"alg": "Ed25519", "typ": "vc+jwt", "cty": "vc", "kid": manifest["keyId"]}, "packageId": manifest["packageId"], "issuerAuthority": "self-issued-package-attestation", "currentStatus": "unknown", "capabilityVerified": false, "remotePublished": false, "audienceEncrypted": false}, nil
}

// ValidateVCPreview precedes the host's purpose-limited existing-key signer. It
// never accepts, retrieves, generates or exports a private key.
func ValidateVCPreview(preview Object, now int64) (Object, error) {
	if !vcSeconds(now) || !integer(object(preview["credential"])["iat"], 0) || !vcSeconds(number(object(preview["credential"])["iat"])) {
		return nil, fail("trust_vc_time_invalid", 422)
	}
	issued := number(object(preview["credential"])["iat"])
	if issued > now+300 {
		return nil, fail("trust_vc_signature_time_future", 422)
	}
	rebuilt, e := PrepareVC(object(preview["package"]), issued)
	if e != nil {
		return nil, e
	}
	if !same(rebuilt, preview) {
		return nil, fail("trust_vc_preview_changed", 422)
	}
	if number(object(preview["credential"])["exp"]) <= now {
		return nil, fail("trust_vc_package_not_current", 422)
	}
	return rebuilt, nil
}
func SignVC(preview Object, now int64, sign func(payload string, header Object) (string, error)) (string, error) {
	checked, e := ValidateVCPreview(preview, now)
	if e != nil {
		return "", e
	}
	if sign == nil {
		return "", fail("trust_vc_signer_unavailable", 503)
	}
	return sign(str(checked, "payloadJson"), object(checked["protectedHeader"]))
}
func parseVCBundle(bundle Object) error {
	if !exact(bundle, []string{"format", "mediaType", "credential", "package"}, nil) || bundle["format"] != VCProfile || bundle["mediaType"] != VCMediaType || !boundedText(bundle["credential"], 1, 800000) {
		return fail("invalid_trust_vc_bundle", 422)
	}
	return parseContainer(object(bundle["package"]))
}
func SealVC(preview Object, signature string, now int64) (Object, error) {
	checked, e := ValidateVCPreview(preview, now)
	if e != nil {
		return nil, e
	}
	container := object(checked["package"])
	manifest, _, key, e := vcPackageDetails(container, now)
	if e != nil {
		return nil, e
	}
	issuer, e := SubjectURI(str(manifest, "subjectId"))
	if e != nil {
		return nil, e
	}
	bundle := Object{"format": VCProfile, "mediaType": VCMediaType, "credential": signature, "package": container}
	options := VCVerifyOptions{Now: now, TrustedIssuers: map[string]map[string]VCIssuerPin{issuer: {str(manifest, "keyId"): {PublicKeyPEM: str(key, "publicKey")}}}}
	if a := object(manifest["audience"]); a["kind"] == "subjects" {
		first := wireString(array(a["subjectIds"])[0])
		options.Audience = &first
	}
	if _, e = VerifyVC(bundle, options); e != nil {
		return nil, e
	}
	return bundle, nil
}
func vcDecode(part string) ([]byte, error) {
	raw, e := base64.RawURLEncoding.DecodeString(part)
	if e != nil || len(raw) == 0 || base64.RawURLEncoding.EncodeToString(raw) != part {
		return nil, fail("trust_vc_compact_encoding", 422)
	}
	return raw, nil
}

func VerifyVC(input any, options VCVerifyOptions) (Object, error) {
	now := options.Now
	if !vcSeconds(now) {
		return nil, fail("trust_vc_time_invalid", 422)
	}
	var bundle Object
	switch v := input.(type) {
	case string:
		if len(units(v)) > 6500000 {
			return nil, fail("trust_vc_package_limit", 422)
		}
		var e error
		bundle, e = decodeObject([]byte(v))
		if e != nil {
			return nil, e
		}
	case map[string]any:
		bundle = v
	default:
		return nil, fail("invalid_trust_vc_bundle", 422)
	}
	if e := parseVCBundle(bundle); e != nil {
		return nil, e
	}
	token := str(bundle, "credential")
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, fail("trust_vc_compact_encoding", 422)
	}
	headerRaw, e := vcDecode(parts[0])
	if e != nil {
		return nil, e
	}
	payloadRaw, e := vcDecode(parts[1])
	if e != nil {
		return nil, e
	}
	if _, e = vcDecode(parts[2]); e != nil {
		return nil, e
	}
	if !utf8.Valid(headerRaw) || !utf8.Valid(payloadRaw) {
		return nil, fail("trust_vc_compact_encoding", 422)
	}
	header, e := decodeObject(headerRaw)
	if e != nil {
		return nil, e
	}
	if !exact(header, []string{"alg", "cty", "kid", "typ"}, nil) || header["alg"] != "Ed25519" || header["typ"] != "vc+jwt" || header["cty"] != "vc" || !hashPattern.MatchString(str(header, "kid")) {
		return nil, fail("trust_vc_header_profile", 422)
	}
	ordered, e := protocol.DecodeOrdered(headerRaw)
	if e != nil {
		return nil, e
	}
	minimal, e := protocol.EncodeJS(ordered)
	if e != nil || string(minimal) != string(headerRaw) {
		return nil, fail("trust_vc_header_encoding", 422)
	}
	vc, e := decodeObject(payloadRaw)
	if e != nil {
		return nil, e
	}
	text, e := canonical(vc)
	if e != nil || text != string(payloadRaw) {
		return nil, fail("trust_vc_payload_encoding", 422)
	}
	issuer := str(vc, "issuer")
	pin, ok := options.TrustedIssuers[issuer][str(header, "kid")]
	if !ok || pin.PublicKeyPEM == "" {
		return nil, fail("trust_vc_issuer_pin_required", 422)
	}
	if pin.Revoked {
		return nil, fail("trust_vc_issuer_pin_revoked", 422)
	}
	verified, kid, e := identity.VerifyTrustVCSignature(token, pin.PublicKeyPEM)
	if e != nil {
		return nil, e
	}
	if verified != string(payloadRaw) || kid != str(header, "kid") {
		return nil, fail("trust_vc_signature_invalid", 422)
	}
	if !same(vc["@context"], []any{vcContext}) || !same(vc["type"], []any{"VerifiableCredential"}) || vc["iss"] != issuer || number(vc["exp"]) <= now {
		return nil, fail("trust_vc_document_profile", 422)
	}
	container := object(bundle["package"])
	manifest, result, key, e := vcPackageDetails(container, now)
	if e != nil {
		return nil, e
	}
	if pin.PublicKeyPEM != str(key, "publicKey") || identity.Digest([]byte(pin.PublicKeyPEM)) != header["kid"] || header["kid"] != manifest["keyId"] {
		return nil, fail("trust_vc_issuer_key_mismatch", 422)
	}
	issued := number(vc["iat"])
	if !integer(vc["iat"], 0) || issued < number(manifest["issuedAt"]) || issued > now+300 || issued >= number(manifest["expiresAt"]) {
		return nil, fail("trust_vc_signature_time_mismatch", 422)
	}
	if pin.NotBefore != nil && (*pin.NotBefore < -9007199254740991 || *pin.NotBefore > 9007199254740991 || *pin.NotBefore > issued) || pin.NotAfter != nil && (*pin.NotAfter < -9007199254740991 || *pin.NotAfter > 9007199254740991 || *pin.NotAfter < issued) {
		return nil, fail("trust_vc_issuer_pin_interval", 422)
	}
	resource, e := vcResource(container)
	if e != nil {
		return nil, e
	}
	expected, e := credentialFor(manifest, object(container["files"])["summary.md"], resource, issued)
	if e != nil {
		return nil, e
	}
	if !same(vc, expected) {
		return nil, fail("trust_vc_package_credential_mismatch", 422)
	}
	if options.ExpectedIssuer != nil && issuer != *options.ExpectedIssuer {
		return nil, fail("trust_vc_expected_issuer_mismatch", 422)
	}
	if options.ExpectedSubject != nil {
		uri, e := SubjectURI(*options.ExpectedSubject)
		if e != nil {
			return nil, e
		}
		if object(vc["credentialSubject"])["id"] != uri {
			return nil, fail("trust_vc_expected_subject_mismatch", 422)
		}
	}
	if number(manifest["issuedAt"]) > now || number(manifest["expiresAt"]) <= now {
		return nil, fail("trust_vc_package_not_current", 422)
	}
	audience := object(manifest["audience"])
	if audience["kind"] == "subjects" {
		if options.Audience == nil {
			return nil, fail("trust_vc_audience_required", 422)
		}
		if !containsSubject(array(audience["subjectIds"]), *options.Audience) {
			return nil, fail("trust_vc_audience_mismatch", 422)
		}
	}
	if options.Audience != nil && !subjectPattern.MatchString(*options.Audience) {
		return nil, fail("invalid_trust_subject", 422)
	}
	return Object{"profile": VCProfile, "mediaType": VCMediaType, "integrity": "valid", "issuer": issuer, "subjectId": manifest["subjectId"], "packageId": manifest["packageId"], "issuerAuthority": "self-issued-package-attestation", "issuerPinSelected": true, "signature": "valid-for-selected-issuer-key-and-included-control-history", "temporalState": "within-declared-interval", "issuedAt": vc["iat"], "validFrom": vc["validFrom"], "validUntil": vc["validUntil"], "audience": manifest["audience"], "currentStatus": "unknown", "currentRevocationChecked": false, "capabilityVerified": false, "onlineAccessGranted": false, "audienceEncrypted": false, "ordinaryPackage": result, "importedBusinessFacts": 0, "networkRequests": 0}, nil
}
func containsSubject(values []any, subject string) bool {
	for _, v := range values {
		if v == subject {
			return true
		}
	}
	return false
}
