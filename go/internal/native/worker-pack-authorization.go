package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

func workerPreparedAuthorization(ctx context.Context, l *nativeIdentityLease, payload, action, objectID, visibility string, viewers []string, expires int64, id string) (map[string]any, error) {
	if viewers == nil {
		viewers = []string{}
	}
	fields, e := nativeAuthorizationFields(payload)
	if e != nil {
		return nil, e
	}
	if id == "" {
		id = uuid.NewString()
	}
	now := l.runtime.connection.now().Unix()
	if expires == 0 {
		expires = now + 2591900
	}
	purpose := "operational"
	if visibility == "Public" {
		purpose = "public-profile"
	}
	intent := nativeAuthorizationIntent{1, id, l.scope.Owner, l.connection.bindingID, l.runtime.config.Endpoint, objectID, action, purpose, l.runtime.config.Endpoint, fields, visibility, viewers, identity.Digest([]byte(payload)), "0.1", now, expires}
	if e = nativeAuthorizationPolicy(intent, now); e != nil {
		return nil, e
	}
	if remoteChatValidate(uploadObject(nativeAuthorizationContracts()["consent"]), intent) != nil {
		return nil, a2aError("invalid Worker Consent")
	}
	raw, e := localdata.Encode(intent)
	if e != nil {
		return nil, e
	}
	signed, e := l.runtime.connection.sign(ctx, l.connection, string(raw), "galaxy-consent+jws")
	if e != nil {
		return nil, e
	}
	return map[string]any{"version": 1, "endpoint": l.runtime.config.Endpoint, "intent": uploadObject(intent), "signedIntent": signed, "payloadJson": payload}, nil
}
func workerConsentReceipt(ctx context.Context, l *nativeIdentityLease, prepared map[string]any) (map[string]any, error) {
	intent, e := nativeAuthorizationPrepared(l, prepared)
	if e != nil {
		return nil, e
	}
	result, e := l.call(ctx, "/v2/consents/receipt", map[string]any{"consentId": intent.ID}, false)
	if e != nil {
		return nil, e
	}
	if result["state"] == "absent" && result["consentId"] == intent.ID {
		return map[string]any{"state": "absent"}, nil
	}
	if result["consentId"] != intent.ID || result["signatureHash"] != identity.Digest([]byte(text(prepared["signedIntent"]))) || result["status"] != "active" || !connectionEqual(result["intent"], prepared["intent"]) {
		return nil, connectionFailure("consent_receipt_not_active_or_mismatched")
	}
	return map[string]any{"state": "acknowledged", "consentId": intent.ID, "payloadJson": prepared["payloadJson"]}, nil
}
func (h *NativeWorkerHost) authorizeResult(ctx context.Context, l *nativeIdentityLease, input map[string]any) (map[string]any, error) {
	normalized, e := nativeAuthorizationNormalize(input)
	if e != nil {
		return nil, e
	}
	if normalized["action"] != "case.teaser.publish" || !isOne(text(normalized["visibility"]), "Private", "Public") {
		return nil, a2aError("Worker result intent mismatch")
	}
	var event map[string]any
	if protocol.Decode([]byte(text(normalized["payloadJson"])), &event) != nil || event["kind"] != "result-recorded" || event["actorId"] != l.scope.Owner || event["eventId"] != normalized["objectId"] || len([]rune(text(normalized["payloadJson"]))) > 16000 {
		return nil, a2aError("Worker result intent mismatch")
	}
	key := workerPrefix(l) + "result-authorization:" + text(normalized["requestId"])
	saved, e := workerRead(ctx, l, key)
	if e != nil {
		return nil, e
	}
	record := a2aObject(saved)
	if saved != nil && (record["owner"] != l.scope.Owner || record["endpoint"] != l.runtime.config.Endpoint || !connectionEqual(a2aObject(record["input"]), normalized)) {
		return nil, a2aError("Worker original authorization request changed")
	}
	if saved == nil {
		prepared, e := workerPreparedAuthorization(ctx, l, text(normalized["payloadJson"]), "case.teaser.publish", text(normalized["objectId"]), text(normalized["visibility"]), mustUploadStrings(normalized["viewers"]), a2aInteger(normalized["expiresAt"]), text(normalized["requestId"]))
		if e != nil {
			return nil, e
		}
		orderedInput, e := nativeAuthorizationInputJSON(normalized)
		if e != nil {
			return nil, e
		}
		inputOrdered, e := protocol.DecodeOrdered(orderedInput)
		if e != nil {
			return nil, e
		}
		created := protocol.NewOrderedObject()
		created.Set("owner", l.scope.Owner)
		created.Set("endpoint", l.runtime.config.Endpoint)
		created.Set("input", inputOrdered)
		created.Set("prepared", prepared)
		created.Set("state", "prepared")
		saved, e = workerUpdate(ctx, l, key, func(previous any) (any, error) {
			if previous != nil {
				return nil, a2aError("Worker original authorization changed")
			}
			return created, nil
		})
		if e != nil {
			return nil, e
		}
		record = a2aObject(saved)
	}
	prepared := uploadObject(record["prepared"])
	intent, e := nativeAuthorizationPrepared(l, prepared)
	if e != nil {
		return nil, e
	}
	if _, e = workerUpdate(ctx, l, key, func(previous any) (any, error) {
		if !connectionEqual(a2aObject(previous)["prepared"], record["prepared"]) {
			return nil, a2aError("Worker original authorization changed")
		}
		next := workerOrdered(workerClone(previous))
		next.Set("state", "result-unknown")
		return next, nil
	}); e != nil {
		return nil, e
	}
	result, e := h.runtime.submitSavedAuthorization(ctx, l, prepared, intent)
	if e != nil {
		return nil, e
	}
	_, e = workerUpdate(ctx, l, key, func(previous any) (any, error) {
		next := workerOrdered(workerClone(previous))
		next.Set("state", "active")
		next.Set("receipt", result)
		return next, nil
	})
	if e != nil {
		return nil, e
	}
	out := a2aClone(result)
	out["requestId"] = normalized["requestId"]
	out["state"] = "active"
	return out, nil
}
func (h *NativeWorkerHost) executeResult(ctx context.Context, l *nativeIdentityLease, p *WorkerPreview) (map[string]any, error) {
	id := text(p.row["associationId"])
	inner := p.inner
	result, e := h.a2a.reconcileResult(ctx, inner.lease, inner.journal, id)
	if e != nil {
		return nil, e
	}
	if result["state"] == "acknowledged" {
		return uploadObject(result["receipt"]), nil
	}
	if result["state"] != "absent" {
		return nil, a2aError("original Worker Result unavailable")
	}
	link, e := inner.journal.get(ctx, id)
	if e != nil {
		return nil, e
	}
	if _, _, _, e = h.a2a.access(ctx, inner.peer, inner.lease, link, nil); e != nil {
		return nil, e
	}
	auth := uploadObject(inner.value["authorization"])
	accepted, e := h.authorizeResult(ctx, l, auth)
	if e != nil {
		return nil, e
	}
	receipt, e := l.call(ctx, "/v2/cases/events", map[string]any{"consentId": accepted["consentId"], "payloadJson": auth["payloadJson"]}, false)
	if e != nil {
		return nil, e
	}
	if _, e = h.a2a.recordResult(ctx, inner.lease, inner.journal, id, receipt); e != nil {
		return nil, e
	}
	out := a2aClone(receipt)
	out["externalSource"] = uploadObject(inner.value["draft"])["source"]
	return out, nil
}
