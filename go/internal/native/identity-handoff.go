package native

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"regexp"
	"strings"
)

type NativeDeviceHandoff struct {
	runtime *Runtime
	serial  chan struct{}
}

func NewNativeDeviceHandoff(runtime *Runtime) *NativeDeviceHandoff {
	return &NativeDeviceHandoff{runtime: runtime, serial: make(chan struct{}, 1)}
}

var handoffUUIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func handoffUUID(value any) bool {
	v, ok := value.(string)
	return ok && handoffUUIDPattern.MatchString(v)
}
func (h *NativeDeviceHandoff) key(id string) string {
	return "identity-handoff:" + h.runtime.config.Endpoint + ":" + id
}
func (h *NativeDeviceHandoff) pendingKey() string {
	return "identity-handoff:" + h.runtime.config.Endpoint + ":pending"
}
func (h *NativeDeviceHandoff) begin(ctx context.Context) (context.Context, func(), *nativeIdentityLease, error) {
	ctx, cancel, l, e := h.runtime.handoffLease(ctx)
	if e != nil {
		return nil, nil, nil, e
	}
	select {
	case h.serial <- struct{}{}:
	case <-ctx.Done():
		cancel()
		return nil, nil, nil, ctx.Err()
	}
	if e = l.check(ctx); e != nil {
		<-h.serial
		cancel()
		return nil, nil, nil, e
	}
	return ctx, func() { <-h.serial; cancel() }, l, nil
}
func handoffScopes(value any) ([]string, error) {
	scopes, ok := connectionStrings(value)
	if !ok || len(scopes) == 0 || len(scopes) > 64 || !connectionIncludes(scopes, "binding") {
		return nil, connectionFailure("device_scopes_invalid")
	}
	seen := map[string]bool{}
	allowed := append([]string{"manage-identity"}, connectionBrowserScopes...)
	for _, scope := range scopes {
		if seen[scope] || !connectionIncludes(allowed, scope) {
			return nil, connectionFailure("device_scopes_invalid")
		}
		seen[scope] = true
	}
	return scopes, nil
}
func handoffObject(raw string) (map[string]any, error) {
	if protocol.TextLength(raw) > 24000 || strings.Contains(raw, "PRIVATE KEY") || strings.Contains(raw, "galaxy-recovery-v1:") {
		return nil, connectionFailure("device_handoff_private_material")
	}
	value, e := connectionObject([]byte(raw))
	if e != nil {
		return nil, connectionFailure("device_handoff_invalid")
	}
	return value, nil
}
func (h *NativeDeviceHandoff) offer(value map[string]any) (map[string]any, error) {
	if !connectionExact(value, "version", "type", "endpoint", "subjectId", "operationId", "deviceId", "publicKeyPem", "scopes") || integer(value["version"]) != 1 || value["type"] != "galaxy-device-request" || value["endpoint"] != h.runtime.config.Endpoint || !connectionSubject.MatchString(text(value["subjectId"])) || !handoffUUID(value["operationId"]) || !handoffUUID(value["deviceId"]) || protocol.TextLength(text(value["publicKeyPem"])) > 256 || !connectionCanonicalPublic(text(value["publicKeyPem"])) {
		return nil, connectionFailure("device_request_invalid")
	}
	if _, e := handoffScopes(value["scopes"]); e != nil {
		return nil, e
	}
	return value, nil
}
func (h *NativeDeviceHandoff) approval(value map[string]any) (map[string]any, error) {
	if !connectionExact(value, "version", "type", "endpoint", "offer", "request", "challenge", "controllerSignature") || integer(value["version"]) != 1 || value["type"] != "galaxy-device-approval" || value["endpoint"] != h.runtime.config.Endpoint {
		return nil, connectionFailure("device_approval_invalid")
	}
	offer, e := h.offer(uploadObject(value["offer"]))
	if e != nil {
		return nil, e
	}
	request := uploadObject(value["request"])
	device := uploadObject(request["newDevice"])
	if !connectionExact(request, "version", "operationId", "subjectId", "kind", "expectedEpoch", "previousEventHash", "signerKeyId", "newDevice") || integer(request["version"]) != 2 || request["kind"] != "authorize-device" || request["operationId"] != offer["operationId"] || request["subjectId"] != offer["subjectId"] || !connectionExact(device, "deviceId", "publicKeyPem", "scopes") || device["deviceId"] != offer["deviceId"] || device["publicKeyPem"] != offer["publicKeyPem"] {
		return nil, connectionFailure("device_approval_changed_request")
	}
	scopes, e := handoffScopes(device["scopes"])
	if e != nil {
		return nil, e
	}
	for _, scope := range scopes {
		if !connectionIncludes(mustUploadStrings(offer["scopes"]), scope) {
			return nil, connectionFailure("device_approval_changed_request")
		}
	}
	challenge, e := connectionObject([]byte(text(value["challenge"])))
	if e != nil {
		return nil, connectionFailure("device_challenge_invalid")
	}
	nonce, e := base64.RawURLEncoding.Strict().DecodeString(text(challenge["nonce"]))
	if !connectionExact(challenge, "version", "type", "audience", "request", "nonce", "expiresAt") || integer(challenge["version"]) != 2 || challenge["type"] != "identity-control" || challenge["audience"] != h.runtime.config.Endpoint || !connectionEqual(challenge["request"], request) || e != nil || len(nonce) != 32 || !connectionSafeInteger(challenge["expiresAt"]) {
		return nil, connectionFailure("device_challenge_changed")
	}
	return value, nil
}
func handoffVerify(signature, payload, public string) error {
	header, _, sig, input, e := connectionSigned(signature)
	if e != nil || !connectionExact(header, "alg", "typ") || header["alg"] != "Ed25519" || header["typ"] != "galaxy-identity-control-v2+jws" {
		return connectionFailure("device_approval_signature_invalid")
	}
	parts := strings.Split(signature, ".")
	raw, e := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	key, keyError := connectionPublicPEM(public)
	if e != nil || keyError != nil || string(raw) != payload || !ed25519.Verify(key, []byte(input), sig) {
		return connectionFailure("device_approval_signature_invalid")
	}
	return nil
}
func (h *NativeDeviceHandoff) prepareControl(ctx context.Context, l *nativeIdentityLease, request map[string]any) (map[string]any, error) {
	key := identityOperationKey(h.runtime.config.Endpoint, text(request["operationId"]))
	previous, e := l.read(ctx, key)
	if e != nil {
		return nil, e
	}
	if previous != nil && !connectionEqual(previous["request"], request) {
		return nil, connectionFailure("device_handoff_original_changed")
	}
	response, e := l.call(ctx, "/v2/identity/control/challenges", request, true)
	if e != nil {
		return nil, e
	}
	raw := text(response["challenge"])
	challenge, e := connectionObject([]byte(raw))
	if e != nil {
		return nil, e
	}
	nonce, nonceError := base64.RawURLEncoding.Strict().DecodeString(text(challenge["nonce"]))
	if !connectionExact(challenge, "version", "type", "audience", "request", "nonce", "expiresAt") || integer(challenge["version"]) != 2 || challenge["type"] != "identity-control" || challenge["audience"] != h.runtime.config.Endpoint || !connectionEqual(challenge["request"], request) || response["operationId"] != request["operationId"] || nonceError != nil || len(nonce) != 32 || !connectionSafeInteger(challenge["expiresAt"]) || integer(challenge["expiresAt"]) <= h.runtime.connection.now().Unix() || integer(challenge["expiresAt"]) > h.runtime.connection.now().Unix()+180 || !connectionEqual(response["expiresAt"], challenge["expiresAt"]) {
		return nil, connectionFailure("device_challenge_changed")
	}
	if previous == nil {
		previous = map[string]any{"request": request, "challenge": raw, "expiresAt": challenge["expiresAt"], "state": "prepared"}
	} else if previous["challenge"] != raw {
		return nil, connectionFailure("device_challenge_changed")
	}
	e = l.update(ctx, key, func(current map[string]any) (map[string]any, error) {
		if current != nil && !connectionEqual(current, previous) {
			return nil, connectionFailure("device_handoff_original_changed")
		}
		return previous, nil
	})
	return previous, e
}
func (h *NativeDeviceHandoff) Pending(ctx context.Context) (any, error) {
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	value, e := l.readAny(ctx, h.pendingKey())
	if e != nil || value == nil {
		return nil, e
	}
	id := text(value)
	record, e := l.read(ctx, h.key(id))
	if e != nil || record == nil {
		return nil, e
	}
	offer := uploadObject(record["offer"])
	if active := l.connection.selection.Active; active != nil && active.SubjectID != offer["subjectId"] {
		return nil, connectionFailure("device_identity_switch_required")
	}
	saved, e := l.read(ctx, identityOperationKey(h.runtime.config.Endpoint, id))
	if e != nil {
		return nil, e
	}
	receipt := uploadObject(record["receipt"])
	if receipt == nil {
		receipt = map[string]any{"registered": saved["commit"] != nil}
	}
	result := map[string]any{"operationId": id, "offer": offer, "state": record["state"], "approval": record["approval"], "receipt": record["receipt"], "needsLocalDeviceSelection": l.connection.selection.Active != nil && l.connection.selection.Active.SubjectID == offer["subjectId"] && l.connection.selection.Active.DeviceID != offer["deviceId"] && receipt["state"] == "committed" && saved["commit"] != nil && !isOne(text(record["state"]), "canceled", "expired")}
	for key, value := range handoffMetadata(record, saved, receipt) {
		result[key] = value
	}
	return result, nil
}
func handoffMetadata(record, saved, receipt map[string]any) map[string]any {
	terminal := isOne(text(record["state"]), "canceled", "expired", "committed")
	return map[string]any{"registered": receipt["registered"] != false && saved["commit"] != nil, "hasOriginalCommit": saved["commit"] != nil, "canRetryOriginalCommit": saved["commit"] != nil && receipt["state"] == "requested" && !terminal, "needsReview": record["approval"] != nil && saved["commit"] == nil && !terminal && !isOne(text(receipt["state"]), "canceled", "expired", "committed")}
}
func (h *NativeDeviceHandoff) OfferReviewed(ctx context.Context, subject string, scope *ChoiceScope) (any, error) {
	if scope == nil || !connectionSubject.MatchString(subject) {
		return nil, connectionFailure("device_request_confirmation_required")
	}
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	if l.scope != *scope {
		return nil, connectionFailure("device_handoff_owner_changed")
	}
	if active := l.connection.selection.Active; active != nil && active.SubjectID != subject {
		return nil, connectionFailure("device_identity_switch_required")
	}
	selected := append([]string{"manage-identity"}, connectionBrowserScopes...)
	pending, e := l.readAny(ctx, h.pendingKey())
	if e != nil {
		return nil, e
	}
	if pending != nil {
		record, e := l.read(ctx, h.key(text(pending)))
		if e != nil {
			return nil, e
		}
		if record != nil && !isOne(text(record["state"]), "canceled", "committed", "expired") {
			offer := uploadObject(record["offer"])
			if offer["subjectId"] != subject || !connectionEqual(offer["scopes"], selected) {
				return nil, connectionFailure("device_pending_request_exists")
			}
			return identityClone(offer), nil
		}
	}
	if _, e = l.handoffControl(ctx, subject); e != nil {
		return nil, e
	}
	var offer map[string]any
	e = h.runtime.store.With(ctx, true, func(dir string) error {
		if e := h.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		var current any
		if _, e := readJSON(connectionRecordPath(dir, h.pendingKey()), &current); e != nil {
			return e
		}
		if !connectionEqual(current, pending) {
			return connectionFailure("device_pending_request_exists")
		}
		material, e := l.newHandoffDeviceWithin(dir, subject)
		if e != nil {
			return e
		}
		operationID := uuid.NewString()
		offer = map[string]any{"version": 1, "type": "galaxy-device-request", "endpoint": h.runtime.config.Endpoint, "subjectId": subject, "operationId": operationID, "deviceId": material["deviceId"], "publicKeyPem": material["publicKeyPem"], "scopes": selected}
		if e = uploadNativeRecordWithin(dir, h.key(operationID), map[string]any{"offer": offer, "installationId": uuid.NewString(), "state": "offered"}); e != nil {
			return e
		}
		return uploadNativeRecordWithin(dir, h.pendingKey(), operationID)
	})
	if e != nil {
		return nil, e
	}
	return offer, l.check(ctx)
}
