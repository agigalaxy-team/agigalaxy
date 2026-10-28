package trustpackages

import (
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"strings"
)

func originalProofStatus(source, original Object, options VerifyOptions, invalid Object) Object {
	parts := strings.Split(str(original, "signed"), ".")
	if len(parts) != 3 {
		return invalid
	}
	raw, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return invalid
	}
	header, e := decodeObject(raw)
	if e != nil {
		return invalid
	}
	pin, ok := options.TrustedIssuers[str(original, "issuer")][str(header, "kid")]
	if !ok {
		return Object{"status": "not-checked", "reason": "receiver-has-no-selected-issuer-key"}
	}
	payload, key, e := identity.VerifyTrustProofSignature(str(original, "signed"), pin.PublicKeyPEM)
	if e != nil || key != str(header, "kid") {
		return invalid
	}
	p, e := decodeObject([]byte(payload))
	if e != nil {
		return invalid
	}
	body, e := decodeObject([]byte(wireString(source["bodyText"])))
	if e != nil {
		return invalid
	}
	if !exact(header, []string{"alg", "kid", "typ"}, nil) || header["alg"] != "Ed25519" || header["typ"] != "galaxy-proof+jwt" || p["iss"] != original["issuer"] || p["aud"] != original["issuer"] || object(p["data"])["type"] != "ci-execution-observation" || !same(p["data"], body) {
		return invalid
	}
	return Object{"status": "signature-valid", "meaning": "limited-ci-observation-only", "issuerKeyRevoked": pin.Revoked, "issuerKeyValidAtReportedSigning": integer(p["iat"], -9007199254740991) && pin.NotBefore <= number(p["iat"]) && pin.NotAfter >= number(p["iat"]), "sourceExpiresAt": p["exp"], "currentRevocationChecked": false}
}
