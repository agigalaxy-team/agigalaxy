package native

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"strings"
)

type NativeAuthorizationInput struct {
	RequestID   string   `json:"requestId"`
	Action      string   `json:"action"`
	ObjectID    string   `json:"objectId"`
	PayloadJSON string   `json:"payloadJson"`
	Visibility  string   `json:"visibility"`
	Viewers     []string `json:"viewers"`
	ExpiresAt   *int64   `json:"expiresAt,omitempty"`
}
type nativeAuthorizationIntent struct {
	Version       int      `json:"version"`
	ID            string   `json:"id"`
	SubjectID     string   `json:"subjectId"`
	BindingID     string   `json:"bindingId"`
	Endpoint      string   `json:"endpoint"`
	ObjectID      string   `json:"objectId"`
	Action        string   `json:"action"`
	Purpose       string   `json:"purpose"`
	Recipient     string   `json:"recipient"`
	Fields        []string `json:"fields"`
	Visibility    string   `json:"visibility"`
	Viewers       []string `json:"viewers"`
	PayloadHash   string   `json:"payloadHash"`
	PolicyVersion string   `json:"policyVersion"`
	IssuedAt      int64    `json:"issuedAt"`
	ExpiresAt     int64    `json:"expiresAt"`
}

func nativeAuthorizationContracts() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(nativeAuthorizationContractsJSON), &value)
	return value
}
func nativeAuthorizationInputJSON(normalized map[string]any) (json.RawMessage, error) {
	raw, e := protocol.Encode(normalized)
	if e != nil {
		return nil, e
	}
	var input NativeAuthorizationInput
	if e = protocol.Decode(raw, &input); e != nil {
		return nil, e
	}
	encoded, e := localdata.Encode(input)
	return json.RawMessage(encoded), e
}
func nativeAuthorizationNormalize(input any) (map[string]any, error) {
	schema := uploadObject(nativeAuthorizationContracts()["input"])
	if remoteChatValidate(schema, input) != nil {
		return nil, fault.New("native_authorization_input_invalid", 400)
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var value map[string]any
	if protocol.Decode(raw, &value) != nil {
		return nil, fault.New("native_authorization_input_invalid", 400)
	}
	if _, ok := value["visibility"]; !ok {
		value["visibility"] = "Private"
	}
	if _, ok := value["viewers"]; !ok {
		value["viewers"] = []any{}
	}
	if number, ok := value["expiresAt"].(json.Number); ok {
		numeric, _ := number.Float64()
		value["expiresAt"] = int64(numeric)
	}
	return value, nil
}
func nativeAuthorizationFields(payload string) ([]string, error) {
	decoder := json.NewDecoder(strings.NewReader(payload))
	decoder.UseNumber()
	token, e := decoder.Token()
	if e != nil || token != json.Delim('{') {
		return nil, fault.New("invalid_consent", 400)
	}
	fields := []string{}
	seen := map[string]bool{}
	for decoder.More() {
		key, e := decoder.Token()
		if e != nil {
			return nil, e
		}
		name, ok := key.(string)
		if !ok {
			return nil, fault.New("invalid_consent", 400)
		}
		var value json.RawMessage
		if e = decoder.Decode(&value); e != nil {
			return nil, e
		}
		if !seen[name] {
			seen[name] = true
			fields = append(fields, name)
		}
	}
	if _, e = decoder.Token(); e != nil {
		return nil, e
	}
	var tail any
	if decoder.Decode(&tail) != io.EOF {
		return nil, fault.New("invalid_consent", 400)
	}
	return fields, nil
}
func nativeAuthorizationPolicy(intent nativeAuthorizationIntent, now int64) error {
	bad := intent.Visibility == "Local" || intent.IssuedAt > now || intent.IssuedAt < now-300 || intent.ExpiresAt <= now || intent.ExpiresAt-intent.IssuedAt > 2592000 || intent.Visibility == "Hub-scoped" && (!strings.HasPrefix(intent.Recipient, "https://") || len(intent.Viewers) == 0) || intent.Visibility == "Public" && intent.Purpose != "public-profile"
	seen := map[string]bool{}
	for _, field := range intent.Fields {
		if isOne(field, "privateKey", "privateKeyPem", "token", "password", "credentials", "rawContext", "cookie", "authorization") || seen[field] {
			bad = true
		}
		seen[field] = true
	}
	seen = map[string]bool{}
	for _, viewer := range intent.Viewers {
		if seen[viewer] {
			bad = true
		}
		seen[viewer] = true
	}
	if bad {
		return fault.New("consent_policy_denied", 403)
	}
	return nil
}
func (r *Runtime) AuthorizationExists(ctx context.Context, input any) (bool, error) {
	normalized, e := nativeAuthorizationNormalize(input)
	if e != nil {
		return false, e
	}
	var record map[string]any
	e = r.store.With(ctx, false, func(dir string) error {
		_, e := readJSON(connectionRecordPath(dir, "native-authorization:"+r.config.Endpoint+":"+text(normalized["requestId"])), &record)
		return e
	})
	return record != nil && connectionEqual(record["input"], normalized), e
}
func nativeAuthorizationPrepared(lease *nativeIdentityLease, prepared map[string]any) (nativeAuthorizationIntent, error) {
	var intent nativeAuthorizationIntent
	raw, e := protocol.Encode(prepared["intent"])
	if e != nil || protocol.Decode(raw, &intent) != nil || remoteChatValidate(uploadObject(nativeAuthorizationContracts()["consent"]), prepared["intent"]) != nil {
		return intent, fault.New("native_authorization_prepared_invalid", 409)
	}
	if integer(prepared["version"]) != 1 || prepared["endpoint"] != lease.runtime.config.Endpoint || intent.SubjectID != lease.scope.Owner || intent.Endpoint != lease.runtime.config.Endpoint || identity.Digest([]byte(text(prepared["payloadJson"]))) != intent.PayloadHash {
		return intent, fault.New("native_authorization_prepared_changed", 409)
	}
	parts := strings.Split(text(prepared["signedIntent"]), ".")
	if len(parts) != 3 {
		return intent, fault.New("native_authorization_signature_changed", 409)
	}
	headerRaw, e := base64.RawURLEncoding.DecodeString(parts[0])
	if e != nil {
		return intent, e
	}
	header, e := connectionObject(headerRaw)
	if e != nil || !connectionEqual(header, map[string]any{"alg": "Ed25519", "typ": "galaxy-consent+jws"}) {
		return intent, fault.New("native_authorization_signature_changed", 409)
	}
	payloadRaw, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return intent, e
	}
	signed, e := connectionObject(payloadRaw)
	if e != nil || !connectionEqual(signed, prepared["intent"]) {
		return intent, fault.New("native_authorization_signature_changed", 409)
	}
	return intent, nil
}
func (r *Runtime) AuthorizeReviewed(ctx context.Context, input any, expected *ChoiceScope) (map[string]any, error) {
	normalized, e := nativeAuthorizationNormalize(input)
	if e != nil {
		return nil, e
	}
	orderedInput, e := nativeAuthorizationInputJSON(normalized)
	if e != nil {
		return nil, e
	}
	if normalized["action"] == "context.grant" {
		connection, e := r.connection.lease(ctx, false)
		if e != nil {
			return nil, e
		}
		if e = r.connection.checkUpload(ctx, "/v2/context/grants", normalized, "POST", connection, ConnectionLocalUpload{}); e != nil {
			return nil, e
		}
	}
	key := "native-authorization:" + r.config.Endpoint + ":" + text(normalized["requestId"])
	var preliminary map[string]any
	if e = r.store.With(ctx, false, func(dir string) error {
		if expected != nil {
			if e := r.store.verifyChoiceWithin(dir, expected); e != nil {
				return e
			}
		}
		_, e := readJSON(connectionRecordPath(dir, key), &preliminary)
		return e
	}); e != nil {
		return nil, e
	}
	if preliminary == nil && expected == nil {
		return nil, fault.New("native_authorization_choice_required", 403)
	}
	if preliminary != nil && !connectionEqual(preliminary["input"], normalized) {
		return nil, fault.New("native_authorization_request_changed", 409)
	}
	operation, cancel, lease, e := r.identityLease(ctx, true)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if expected != nil && lease.scope != *expected {
		return nil, fault.New("native_choice_binding_changed", 409)
	}
	saved, e := lease.read(operation, key)
	if e != nil {
		return nil, e
	}
	if saved != nil && !connectionEqual(saved["input"], normalized) {
		return nil, fault.New("native_authorization_request_changed", 409)
	}
	if saved == nil && expected == nil {
		return nil, fault.New("native_authorization_choice_required", 403)
	}
	if saved == nil {
		fields, e := nativeAuthorizationFields(text(normalized["payloadJson"]))
		if e != nil {
			return nil, e
		}
		now := r.connection.now().Unix()
		expiry := now + 2591900
		if value, present := normalized["expiresAt"]; present {
			expiry = integer(value)
		}
		viewers := mustUploadStrings(normalized["viewers"])
		if viewers == nil {
			viewers = []string{}
		}
		purpose := "operational"
		if normalized["visibility"] == "Public" {
			purpose = "public-profile"
		}
		intent := nativeAuthorizationIntent{1, text(normalized["requestId"]), lease.scope.Owner, lease.connection.bindingID, r.config.Endpoint, text(normalized["objectId"]), text(normalized["action"]), purpose, r.config.Endpoint, fields, text(normalized["visibility"]), viewers, identity.Digest([]byte(text(normalized["payloadJson"]))), "0.1", now, expiry}
		if remoteChatValidate(uploadObject(nativeAuthorizationContracts()["consent"]), intent) != nil {
			return nil, fault.New("invalid_consent", 400)
		}
		if e = nativeAuthorizationPolicy(intent, now); e != nil {
			return nil, e
		}
		raw, e := localdata.Encode(intent)
		if e != nil {
			return nil, e
		}
		signature, e := r.connection.sign(operation, lease.connection, string(raw), "galaxy-consent+jws")
		if e != nil {
			return nil, e
		}
		prepared := map[string]any{"version": 1, "endpoint": r.config.Endpoint, "intent": uploadObject(intent), "signedIntent": signature, "payloadJson": normalized["payloadJson"]}
		e = lease.update(operation, key, func(prior map[string]any) (map[string]any, error) {
			if prior != nil {
				if !connectionEqual(prior["input"], normalized) {
					return nil, fault.New("native_authorization_request_changed", 409)
				}
				saved = prior
				prior["input"] = orderedInput
				return prior, nil
			}
			saved = map[string]any{"input": orderedInput, "prepared": prepared, "state": "prepared"}
			return saved, nil
		})
		if e != nil {
			return nil, e
		}
	}
	prepared := uploadObject(saved["prepared"])
	intent, e := nativeAuthorizationPrepared(lease, prepared)
	if e != nil {
		return nil, e
	}
	result, submitError := r.submitSavedAuthorization(operation, lease, prepared, intent)
	if submitError != nil {
		if e = lease.check(operation); e != nil {
			return nil, e
		}
		if e = lease.update(operation, key, func(prior map[string]any) (map[string]any, error) {
			if prior != nil && prior["state"] == "active" {
				prior["input"] = orderedInput
				return prior, nil
			}
			next := identityClone(saved)
			next["input"] = orderedInput
			next["state"] = "result-unknown"
			return next, nil
		}); e != nil {
			return nil, e
		}
		return nil, submitError
	}
	if e = lease.update(operation, key, func(prior map[string]any) (map[string]any, error) {
		if prior == nil || !connectionEqual(prior["input"], normalized) || !connectionEqual(prior["prepared"], prepared) {
			return nil, fault.New("native_authorization_request_changed", 409)
		}
		next := identityClone(prior)
		next["input"] = orderedInput
		next["state"] = "active"
		return next, nil
	}); e != nil {
		return nil, e
	}
	result["requestId"], result["state"] = normalized["requestId"], "active"
	return result, nil
}
func (r *Runtime) submitSavedAuthorization(ctx context.Context, lease *nativeIdentityLease, prepared map[string]any, intent nativeAuthorizationIntent) (map[string]any, error) {
	receipt, e := lease.call(ctx, "/v2/consents/receipt", map[string]any{"consentId": intent.ID}, false)
	if e != nil {
		return nil, e
	}
	accepted := func(receipt map[string]any) (map[string]any, error) {
		if receipt["consentId"] != intent.ID || receipt["status"] != "active" || !connectionEqual(receipt["intent"], prepared["intent"]) {
			return nil, fault.New("consent_receipt_not_active_or_mismatched", 409)
		}
		return map[string]any{"consentId": intent.ID, "payloadJson": prepared["payloadJson"]}, nil
	}
	if receipt["state"] != "absent" || receipt["consentId"] != intent.ID {
		if receipt["signatureHash"] != identity.Digest([]byte(text(prepared["signedIntent"]))) {
			return nil, fault.New("consent_signature_receipt_mismatch", 409)
		}
		return accepted(receipt)
	}
	now := r.connection.now().Unix()
	if intent.BindingID != lease.connection.bindingID || intent.IssuedAt < now-300 || intent.ExpiresAt <= now {
		return nil, fault.New("consent_reauthorization_required", 409)
	}
	response, e := lease.call(ctx, "/v1/consents", map[string]any{"signedIntent": prepared["signedIntent"]}, false)
	if e != nil {
		return nil, e
	}
	return accepted(response)
}
