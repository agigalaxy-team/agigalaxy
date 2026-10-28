package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"regexp"
	"sync"
	"sync/atomic"
	"time"
)

const webIdentityProtocol = "galaxy-web-identity-handoff"
const webIdentityProofType = "galaxy-web-identity-handoff-v1+jws"

var webHandoffErrorCode = regexp.MustCompile(`^[a-z0-9_-]{1,100}$`)

type webIdentityBridge struct {
	host                                                                                    *NativeWebHandoff
	lease                                                                                   *nativeIdentityLease
	id, navigationID, hash, target, origin, state, errorCode, nonce, offerHash, fingerprint string
	object, context, browserDevice, signedContext, offer, approval, completed               map[string]any
	scopes                                                                                  []string
	expires, revision                                                                       int64
	mu                                                                                      sync.Mutex
	closed                                                                                  atomic.Bool
	transport                                                                               *webHandoffHTTP
	timer                                                                                   *time.Timer
}

func webCode(e error) string {
	code := runtimeErrorCode(e)
	if webHandoffErrorCode.MatchString(code) {
		return code
	}
	return "web_identity_operation_failed"
}
func (b *webIdentityBridge) URL() string { return b.origin + "/connect/" + b.id }
func (b *webIdentityBridge) stateWithin() map[string]any {
	out := map[string]any{"handoffId": b.id, "navigationId": b.navigationID, "subjectId": b.lease.scope.Owner, "targetPath": b.target, "expiresAt": b.expires, "state": b.state, "revision": b.revision, "error": nil, "transportClosed": b.closed.Load(), "operationId": nil, "deviceAuthorizationVerified": b.completed != nil, "webConnectionReported": b.completed != nil}
	if b.errorCode != "" {
		out["error"] = b.errorCode
	}
	if b.offer != nil {
		out["operationId"] = b.offer["operationId"]
		out["offer"] = b.offer
		out["fingerprint"] = b.fingerprint
	}
	if b.signedContext != nil {
		out["context"] = b.signedContext
	}
	if b.approval != nil {
		out["approval"] = b.approval
	}
	if b.completed != nil {
		out["completed"] = b.completed
	}
	return out
}
func (b *webIdentityBridge) Status() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return psObject(psClone(b.stateWithin()))
}
func (b *webIdentityBridge) current(ctx context.Context) error {
	if b.closed.Load() {
		return connectionFailure("web_identity_transport_closed")
	}
	if b.host.runtime.connection.now().Unix() >= b.expires {
		if !isOne(b.state, "completed", "canceled") {
			b.state = "expired"
		}
		return connectionFailure("web_identity_context_expired")
	}
	return b.lease.check(ctx)
}
func (b *webIdentityBridge) save(ctx context.Context) error {
	b.revision++
	record := b.stateWithin()
	record["inputContext"] = b.context
	record["nonce"] = nil
	if b.nonce != "" {
		record["nonce"] = b.nonce
	}
	record["offerHash"] = nil
	if b.offerHash != "" {
		record["offerHash"] = b.offerHash
	}
	_, e := b.lease.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return e
	}
	return b.lease.runtime.store.With(ctx, true, func(dir string) error {
		if e := b.lease.runtime.store.verifyChoiceWithin(dir, &b.lease.scope); e != nil {
			return e
		}
		return uploadNativeRecordWithin(dir, "web-identity-handoff:"+b.id, record)
	})
}
func (b *webIdentityBridge) readControl(ctx context.Context) (map[string]any, error) {
	state, e := b.lease.control(ctx)
	if e != nil {
		return nil, e
	}
	_, public, e := b.host.runtime.connection.deviceKey(ctx, b.lease.connection)
	if e != nil {
		return nil, e
	}
	device := deviceManager(state, b.lease.scope.DeviceID)
	if state["authority"] != b.lease.scope.Endpoint || state["subjectId"] != b.lease.scope.Owner || device == nil || device["public_key"] != public {
		return nil, connectionFailure("web_identity_current_native_control_required")
	}
	for _, scope := range b.scopes {
		scopes := mustUploadStrings(device["scopes"])
		if !connectionIncludes(scopes, scope) && !connectionIncludes(scopes, "*") {
			return nil, connectionFailure("web_identity_current_native_control_required")
		}
	}
	return state, nil
}
func (b *webIdentityBridge) assertControl(ctx context.Context) (map[string]any, error) {
	state, e := b.readControl(ctx)
	if e != nil {
		return nil, e
	}
	controller := deviceManager(state, b.lease.scope.DeviceID)
	expected := psObject(b.context["controller"])
	if integer(state["epoch"]) != integer(expected["epoch"]) || state["chainHead"] != expected["chainHead"] || controller["key_id"] != expected["keyId"] {
		return nil, connectionFailure("web_identity_native_control_changed")
	}
	return state, b.current(ctx)
}
func (b *webIdentityBridge) beforeApprove(ctx context.Context) error {
	navigation, e := b.host.Navigation.Resume(ctx, b.navigationID)
	if e != nil {
		return e
	}
	if navigation["state"] == "unavailable" || !connectionEqual(navigation["object"], b.object) {
		return connectionFailure("web_identity_original_target_unavailable")
	}
	return b.current(ctx)
}
func (b *webIdentityBridge) accept(ctx context.Context, message map[string]any) (map[string]any, error) {
	if !connectionExact(message, "protocol", "version", "handoffId", "navigationId", "kind", "payload") || message["protocol"] != webIdentityProtocol || integer(message["version"]) != 1 || message["handoffId"] != b.id || message["navigationId"] != b.navigationID {
		return nil, connectionFailure("web_identity_message_invalid")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if e := b.current(ctx); e != nil {
		return nil, e
	}
	kind := text(message["kind"])
	payload := psObject(message["payload"])
	if isOne(b.state, "canceled", "completed", "expired") {
		if kind == "completed" && b.completed != nil && connectionEqual(message["payload"], b.completed["reported"]) || kind == "canceled" && message["payload"] == nil && b.state == "canceled" {
			return b.stateWithin(), nil
		}
		return nil, connectionFailure("web_identity_transport_finished")
	}
	switch kind {
	case "ready":
		if !connectionExact(payload, "nonce", "existingDevice") || !handoffUUID(payload["nonce"]) {
			return nil, connectionFailure("web_identity_nonce_invalid")
		}
		descriptor := psObject(payload["existingDevice"])
		if payload["existingDevice"] != nil && (descriptor == nil || !connectionExact(descriptor, "subjectId", "deviceId", "keyId") || descriptor["subjectId"] != b.lease.scope.Owner || !handoffUUID(descriptor["deviceId"]) || !helpDigest.MatchString(text(descriptor["keyId"]))) {
			return nil, connectionFailure("web_identity_existing_device_invalid")
		}
		if b.nonce != "" {
			if b.nonce != payload["nonce"] || !connectionEqual(descriptor, b.browserDevice) {
				return nil, connectionFailure("web_identity_browser_changed")
			}
			return b.stateWithin(), nil
		}
		control, e := b.assertControl(ctx)
		if e != nil {
			return nil, e
		}
		if e = b.beforeApprove(ctx); e != nil {
			return nil, e
		}
		if descriptor != nil {
			device := deviceManager(control, text(descriptor["deviceId"]))
			if device == nil || device["key_id"] != descriptor["keyId"] || identity.Digest([]byte(text(device["public_key"]))) != descriptor["keyId"] {
				return nil, connectionFailure("web_identity_existing_device_control_required")
			}
		}
		unsigned := helpOrdered(b.context, "endpoint", "website", "subjectId", "controller", "scopes")
		unsigned.Set("controller", helpOrdered(psObject(b.context["controller"]), "deviceId", "keyId", "epoch", "chainHead"))
		unsigned.Set("expiresAt", b.expires)
		unsigned.Set("targetPath", b.target)
		unsigned.Set("existingDevice", nil)
		if descriptor != nil {
			unsigned.Set("existingDevice", helpOrdered(descriptor, "subjectId", "deviceId", "keyId"))
		}
		proof := protocol.NewOrderedObject()
		proof.Set("protocol", webIdentityProtocol)
		proof.Set("version", 1)
		proof.Set("handoffId", b.id)
		proof.Set("navigationId", b.navigationID)
		proof.Set("nonce", payload["nonce"])
		proof.Set("bridgeOrigin", b.origin)
		proof.Set("context", unsigned)
		raw, e := protocol.EncodeJS(proof)
		if e != nil {
			return nil, e
		}
		signature, e := b.lease.sign(ctx, string(raw), webIdentityProofType)
		if e != nil {
			return nil, e
		}
		if e = b.current(ctx); e != nil {
			return nil, e
		}
		if _, e = b.assertControl(ctx); e != nil {
			return nil, e
		}
		if len(signature) > 16000 {
			return nil, connectionFailure("web_identity_proof_invalid")
		}
		b.nonce = text(payload["nonce"])
		b.browserDevice = descriptor
		b.signedContext = identityClone(unsigned)
		b.signedContext["nonce"] = b.nonce
		b.signedContext["bridgeOrigin"] = b.origin
		b.signedContext["proof"] = map[string]any{"payloadJson": string(raw), "signature": signature}
		b.errorCode = ""
		if e = b.save(ctx); e != nil {
			return nil, e
		}
		return b.stateWithin(), nil
	case "offer":
		if b.signedContext == nil {
			return nil, connectionFailure("web_identity_context_required")
		}
		offer, e := b.host.Devices.offer(payload)
		if e != nil {
			return nil, connectionFailure("web_identity_offer_invalid")
		}
		if offer["subjectId"] != b.lease.scope.Owner || !connectionEqual(offer["scopes"], b.context["scopes"]) {
			return nil, connectionFailure("web_identity_offer_invalid")
		}
		raw, e := identity.Canonical(offer)
		if e != nil {
			return nil, e
		}
		hash := identity.Digest(raw)
		if b.offer != nil {
			if b.offerHash != hash {
				return nil, connectionFailure("web_identity_offer_changed")
			}
			return b.stateWithin(), nil
		}
		if _, e = b.assertControl(ctx); e != nil {
			return nil, e
		}
		bytes, e := protocol.Encode(offer)
		if e != nil {
			return nil, e
		}
		preview, _, e := b.host.Devices.PreviewOffer(ctx, string(bytes))
		if e != nil {
			return nil, e
		}
		fingerprint := identity.Digest([]byte(text(offer["publicKeyPem"])))
		if psObject(preview)["fingerprint"] != fingerprint {
			return nil, connectionFailure("web_identity_fingerprint_invalid")
		}
		b.offer = offer
		b.offerHash = hash
		b.fingerprint = fingerprint
		b.state = "offered"
		b.errorCode = ""
		if e = b.save(ctx); e != nil {
			return nil, e
		}
		return b.stateWithin(), nil
	case "completed":
		if b.signedContext == nil {
			return nil, connectionFailure("web_identity_context_required")
		}
		if !connectionExact(payload, "operationId", "subjectId", "deviceId", "epoch", "chainHead", "connected") || payload["operationId"] != nil && !handoffUUID(payload["operationId"]) || !connectionSubject.MatchString(text(payload["subjectId"])) || !handoffUUID(payload["deviceId"]) || !connectionSafeInteger(payload["epoch"]) || integer(payload["epoch"]) < 1 || !helpDigest.MatchString(text(payload["chainHead"])) || payload["connected"] != true {
			return nil, connectionFailure("web_identity_completion_invalid")
		}
		if payload["subjectId"] != b.lease.scope.Owner {
			return nil, connectionFailure("web_identity_subject_changed")
		}
		if b.offer != nil {
			if b.approval == nil || payload["operationId"] != b.offer["operationId"] || payload["deviceId"] != b.offer["deviceId"] {
				return nil, connectionFailure("web_identity_original_operation_required")
			}
		} else if payload["operationId"] != nil || b.browserDevice == nil || b.browserDevice["deviceId"] != payload["deviceId"] {
			return nil, connectionFailure("web_identity_original_device_required")
		}
		control, e := b.readControl(ctx)
		if e != nil {
			return nil, e
		}
		device := deviceManager(control, text(payload["deviceId"]))
		expected := psObject(b.context["controller"])
		valid := integer(control["epoch"]) == integer(payload["epoch"]) && control["chainHead"] == payload["chainHead"] && device != nil
		if valid {
			for _, scope := range b.scopes {
				scopes := mustUploadStrings(device["scopes"])
				if !connectionIncludes(scopes, scope) && !connectionIncludes(scopes, "*") {
					valid = false
				}
			}
			if b.offer != nil {
				valid = valid && device["public_key"] == b.offer["publicKeyPem"] && device["source_event_id"] == b.offer["operationId"]
			} else {
				valid = valid && device["key_id"] == b.browserDevice["keyId"] && identity.Digest([]byte(text(device["public_key"]))) == b.browserDevice["keyId"] && integer(control["epoch"]) == integer(expected["epoch"]) && control["chainHead"] == expected["chainHead"]
			}
		}
		if !valid {
			return nil, connectionFailure("web_identity_current_control_required")
		}
		if e = b.beforeApprove(ctx); e != nil {
			return nil, e
		}
		b.completed = map[string]any{"reported": payload, "deviceAuthorizationVerified": true, "webConnectionReported": true, "websiteConnectionIndependentlyVerified": false, "operationId": payload["operationId"], "subjectId": payload["subjectId"], "deviceId": payload["deviceId"], "epoch": control["epoch"], "chainHead": control["chainHead"]}
		b.state = "completed"
		b.errorCode = ""
		if e = b.save(ctx); e != nil {
			return nil, e
		}
		return b.stateWithin(), nil
	case "canceled":
		if message["payload"] == nil {
			b.state = "canceled"
			b.errorCode = ""
			if e := b.save(ctx); e != nil {
				return nil, e
			}
			return b.stateWithin(), nil
		}
	}
	return nil, connectionFailure("web_identity_message_kind_invalid")
}
func (b *webIdentityBridge) choose(ctx context.Context, action string) (map[string]any, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if e := b.current(ctx); e != nil {
		return nil, e
	}
	if action == "decline" {
		if b.state == "completed" {
			return b.stateWithin(), nil
		}
		b.state = "canceled"
		b.errorCode = ""
		if e := b.save(ctx); e != nil {
			return nil, e
		}
		return b.stateWithin(), nil
	}
	if action != "approve" {
		return nil, connectionFailure("web_identity_choice_invalid")
	}
	if b.approval != nil {
		_, e := b.assertControl(ctx)
		return b.stateWithin(), e
	}
	if b.state != "offered" || b.offer == nil || b.signedContext == nil {
		return nil, connectionFailure("web_identity_offer_required")
	}
	if _, e := b.assertControl(ctx); e != nil {
		return nil, e
	}
	if e := b.beforeApprove(ctx); e != nil {
		return nil, e
	}
	b.state = "approving"
	b.errorCode = ""
	if e := b.save(ctx); e != nil {
		return nil, e
	}
	raw, e := protocol.Encode(b.offer)
	if e != nil {
		return nil, e
	}
	next, e := b.host.Devices.ApproveReviewed(ctx, string(raw), &b.lease.scope)
	if e == nil {
		value := psObject(next)
		request := psObject(value["request"])
		controller := psObject(b.context["controller"])
		offerRaw, _ := identity.Canonical(value["offer"])
		expectedDevice := map[string]any{"deviceId": b.offer["deviceId"], "publicKeyPem": b.offer["publicKeyPem"], "scopes": b.offer["scopes"]}
		if !connectionExact(value, "version", "type", "endpoint", "offer", "request", "challenge", "controllerSignature") || integer(value["version"]) != 1 || value["type"] != "galaxy-device-approval" || value["endpoint"] != b.lease.scope.Endpoint || identity.Digest(offerRaw) != b.offerHash || request["subjectId"] != b.lease.scope.Owner || request["operationId"] != b.offer["operationId"] || integer(request["expectedEpoch"]) != integer(controller["epoch"]) || request["previousEventHash"] != controller["chainHead"] || request["signerKeyId"] != controller["keyId"] || !connectionEqual(request["newDevice"], expectedDevice) {
			e = connectionFailure("web_identity_approval_changed")
		}
		if e == nil {
			_, e = b.assertControl(ctx)
		}
		if e == nil {
			b.approval = value
			b.state = "approved"
			e = b.save(ctx)
		}
	}
	if e != nil {
		b.errorCode = webCode(e)
		if !b.closed.Load() && b.host.runtime.connection.now().Unix() < b.expires {
			b.state = "offered"
		}
		_ = b.save(context.Background())
		return nil, e
	}
	return b.stateWithin(), nil
}
