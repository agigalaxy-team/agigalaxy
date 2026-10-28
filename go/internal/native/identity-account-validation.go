package native

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"net/url"
	"strings"
	"time"
	"unicode"
)

func nativeAccountText(value any, max int) bool {
	text, ok := value.(string)
	if !ok || protocol.TextLength(text) < 1 || protocol.TextLength(text) > max {
		return false
	}
	for _, r := range text {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
func nativeAccountURL(value any) bool {
	u, e := url.Parse(text(value))
	return e == nil && u.IsAbs() && u.Scheme != ""
}
func nativeAccountProvider(value map[string]any, endpoint string, extended bool) bool {
	keys := []string{"id", "name", "issuer", "clientId", "redirectUri", "protocol", "grant", "pkce", "loginLifetimeSeconds"}
	if extended {
		keys = append(keys, "loginId", "authorizationUrl", "expiresAt", "subjectId", "bindingId", "endpoint", "galaxyAuthorization")
	}
	return connectionExact(value, keys...) && nativeAccountProviderID(text(value["id"])) && nativeAccountText(value["name"], 100) && nativeAccountURL(value["issuer"]) && nativeAccountText(value["clientId"], 200) && value["redirectUri"] == endpoint+"/v1/identity/callback/"+text(value["id"]) && value["protocol"] == "openid-connect" && value["grant"] == "authorization_code" && value["pkce"] == "S256" && integer(value["loginLifetimeSeconds"]) == 300
}
func nativeAccountProviderID(value string) bool {
	if len(value) < 1 || len(value) > 64 {
		return false
	}
	for i, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || i > 0 && (c == '.' || c == '_' || c == '-')) {
			return false
		}
	}
	return true
}
func nativeAccountIntent(value map[string]any, l *nativeIdentityLease, now int64) bool {
	return connectionExact(value, "version", "id", "action", "subjectId", "bindingId", "endpoint", "providerId", "issuer", "externalSubject", "clientId", "authentication", "verifiedAt", "issuedAt", "expiresAt", "galaxyAuthorization") && integer(value["version"]) == 1 && controlUUID(value["id"]) && value["action"] == "identity.link" && value["subjectId"] == l.scope.Owner && value["bindingId"] == l.connection.bindingID && value["endpoint"] == l.scope.Endpoint && nativeAccountProviderID(text(value["providerId"])) && nativeAccountURL(value["issuer"]) && nativeAccountText(value["externalSubject"], 255) && nativeAccountText(value["clientId"], 200) && value["authentication"] == "oidc-authorization-code-pkce-s256-id-token-signature" && value["galaxyAuthorization"] == false && connectionSafeInteger(value["verifiedAt"]) && connectionSafeInteger(value["issuedAt"]) && connectionSafeInteger(value["expiresAt"]) && integer(value["verifiedAt"]) <= integer(value["issuedAt"]) && integer(value["issuedAt"]) <= now && integer(value["issuedAt"]) < integer(value["expiresAt"]) && integer(value["expiresAt"]) > now && integer(value["expiresAt"])-integer(value["issuedAt"]) <= 300
}
func nativeAccountPage(value map[string]any, l *nativeIdentityLease) error {
	if !connectionExact(value, "subjectId", "endpoint", "items", "nextAfter") || value["subjectId"] != l.scope.Owner || value["endpoint"] != l.scope.Endpoint || value["nextAfter"] != nil && !controlUUID(value["nextAfter"]) {
		return connectionFailure("native_account_link_page_mismatch")
	}
	items, ok := value["items"].([]any)
	if !ok || len(items) > 100 {
		return connectionFailure("native_account_link_page_mismatch")
	}
	for _, item := range items {
		row := uploadObject(item)
		_, created := time.Parse(time.RFC3339Nano, text(row["createdAt"]))
		revoked := true
		if row["revokedAt"] != nil {
			_, e := time.Parse(time.RFC3339Nano, text(row["revokedAt"]))
			revoked = e == nil && strings.HasSuffix(text(row["revokedAt"]), "Z")
		}
		if !connectionExact(row, "id", "subjectId", "bindingId", "endpoint", "providerId", "issuer", "externalSubject", "clientId", "createdAt", "revokedAt", "state", "galaxyAuthorization") || !controlUUID(row["id"]) || row["subjectId"] != l.scope.Owner || !controlUUID(row["bindingId"]) || row["endpoint"] != l.scope.Endpoint || !nativeAccountProviderID(text(row["providerId"])) || !nativeAccountURL(row["issuer"]) || !nativeAccountText(row["externalSubject"], 255) || !nativeAccountText(row["clientId"], 200) || created != nil || !strings.HasSuffix(text(row["createdAt"]), "Z") || !revoked || !isOne(text(row["state"]), "linked", "revoked", "binding-inactive", "provider-unavailable") || row["galaxyAuthorization"] != false {
			return connectionFailure("native_account_link_page_mismatch")
		}
	}
	return nil
}
