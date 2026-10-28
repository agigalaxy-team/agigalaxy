package agentos

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
)

// Claims are built by the owning operation from durable state. This signer
// never accepts a caller-selected key, algorithm, issuer or audience.
func (c *Client) signToken(claims any) (string, error) {
	if !c.Configured() {
		return "", fail("operations_agentos_not_configured", 503)
	}
	body, err := json.Marshal(claims)
	if err != nil {
		return "", fail("operations_agentos_configuration_invalid", 503)
	}
	head := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	message := head + "." + base64.RawURLEncoding.EncodeToString(body)
	mac := hmac.New(sha256.New, []byte(c.configuration.SigningKey))
	_, _ = mac.Write([]byte(message))
	return message + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}
