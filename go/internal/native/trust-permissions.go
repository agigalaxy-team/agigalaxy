package native

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/trustpackages"
	"math"
)

func trustOriginal(r map[string]any) (map[string]any, error) {
	header, p, _, e := trustCompact(text(r["signed"]))
	if e != nil {
		return nil, connectionFailure("trust_operation_unavailable")
	}
	if header["alg"] != "Ed25519" || header["typ"] != "galaxy-trust-source-permission-v1+jws" {
		return nil, connectionFailure("trust_operation_unavailable")
	}
	if _, e = trustpackages.ParsePermission(p); e != nil {
		return nil, connectionFailure("trust_operation_unavailable")
	}
	for _, k := range []string{"id", "operationId", "kind", "subjectId", "endpoint", "bindingId", "keyId"} {
		if p[k] != r[k] {
			return nil, connectionFailure("trust_operation_unavailable")
		}
	}
	if psInt(p["epoch"]) != psInt(r["epoch"]) {
		return nil, connectionFailure("trust_operation_unavailable")
	}
	return p, nil
}
func (h *NativeTrust) loadPermission(ctx context.Context, l *nativeTrustLease, id string) (map[string]any, error) {
	value, e := l.readKey(ctx, l.key("trust-package:permission:"+id))
	if e != nil {
		return nil, e
	}
	r := psObject(value)
	if r == nil || r["subjectId"] != l.scope.Owner || r["endpoint"] != h.runtime.store.Endpoint || identity.Digest([]byte(text(r["signed"]))) != r["signatureHash"] {
		return nil, connectionFailure("trust_operation_unavailable")
	}
	if _, e = trustOriginal(r); e != nil {
		return nil, e
	}
	return r, l.check(ctx)
}
func (h *NativeTrust) recordPermission(ctx context.Context, l *nativeTrustLease, r map[string]any) error {
	if e := l.check(ctx); e != nil {
		return e
	}
	if e := l.putKey(ctx, l.key("trust-package:permission:"+text(r["operationId"])), r); e != nil {
		return e
	}
	if e := l.check(ctx); e != nil {
		return e
	}
	e := h.runtime.store.With(ctx, true, func(dir string) error {
		if e := h.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		var ids []any
		if _, e := readJSON(connectionRecordPath(dir, l.key("trust-package:pending")), &ids); e != nil {
			return e
		}
		for _, id := range ids {
			if id == r["operationId"] {
				return nil
			}
		}
		ids = append(ids, r["operationId"])
		return uploadNativeRecordWithin(dir, l.key("trust-package:pending"), ids)
	})
	if e != nil {
		return e
	}
	return l.check(ctx)
}
func trustReceiptMatches(r, receipt map[string]any) bool {
	if receipt["state"] != "recorded" {
		return false
	}
	if r["kind"] == "grant" {
		return receipt["operationId"] == r["operationId"] && receipt["signatureHash"] == r["signatureHash"]
	}
	return receipt["revokeOperationId"] == r["operationId"] && receipt["revokeSignatureHash"] == r["signatureHash"]
}
func (h *NativeTrust) reconcilePermission(ctx context.Context, l *nativeTrustLease, r map[string]any) (map[string]any, error) {
	receipt, e := l.call(ctx, "/v2/trust-package/permissions/receipt", map[string]any{"id": r["id"]}, false)
	if e != nil {
		return nil, e
	}
	if receipt["id"] != r["id"] {
		return nil, connectionFailure("trust_receipt_mismatch")
	}
	if trustReceiptMatches(r, receipt) {
		r["state"] = "acknowledged"
		r["receipt"] = receipt
		if e = h.recordPermission(ctx, l, r); e != nil {
			return nil, e
		}
		out, e := trustJSON(receipt)
		if e != nil {
			return nil, e
		}
		out["reconciled"] = true
		return out, nil
	}
	if receipt["state"] == "absent" || r["kind"] == "revoke" && receipt["state"] == "recorded" && receipt["revokeOperationId"] == nil {
		return map[string]any{"id": r["id"], "state": "absent", "operationId": r["operationId"]}, nil
	}
	return nil, connectionFailure("trust_operation_conflict")
}
func (h *NativeTrust) sendPermission(ctx context.Context, l *nativeTrustLease, r map[string]any) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	if l.binding == nil {
		return nil, connectionFailure("trust_connection_required")
	}
	r["state"] = "result-unknown"
	if e := h.recordPermission(ctx, l, r); e != nil {
		return nil, e
	}
	receipt, e := l.call(ctx, "/v2/trust-package/permissions/submit", map[string]any{"signed": r["signed"]}, false)
	if e == nil {
		if !trustReceiptMatches(r, receipt) {
			return nil, connectionFailure("trust_result_unknown")
		}
		r["state"] = "acknowledged"
		r["receipt"] = receipt
		return receipt, h.recordPermission(ctx, l, r)
	}
	if check := l.check(ctx); check != nil {
		return nil, check
	}
	var rejected *ConnectionHTTPError
	if errors.As(e, &rejected) && rejected.Outcome == "rejected" && rejected.Status >= 400 && rejected.Status < 500 && rejected.Status != 401 && rejected.Status != 408 && rejected.Status != 429 && !isOne(rejected.Code, "access_denied", "connection_required", "binding_required", "binding_expired", "invalid_token") {
		r["automaticRetryBlock"] = map[string]any{"code": rejected.Code, "status": rejected.Status, "rejectedAt": h.now()}
		if save := h.recordPermission(ctx, l, r); save != nil {
			return nil, save
		}
	}
	return nil, e
}
func (h *NativeTrust) executePermission(ctx context.Context, l *nativeTrustLease, value map[string]any) (any, error) {
	p, e := trustParseText(value["payloadJson"])
	if e != nil {
		return nil, e
	}
	if _, e = trustpackages.ParsePermission(p); e != nil {
		return nil, e
	}
	signed, e := l.sign(ctx, text(value["payloadJson"]), "galaxy-trust-source-permission-v1+jws")
	if e != nil {
		return nil, e
	}
	r := map[string]any{"operationId": p["operationId"], "id": p["id"], "kind": p["kind"], "subjectId": p["subjectId"], "endpoint": p["endpoint"], "bindingId": p["bindingId"], "generation": nil, "keyId": p["keyId"], "epoch": p["epoch"], "signed": signed, "signatureHash": identity.Digest([]byte(signed)), "state": "prepared"}
	if l.binding != nil {
		r["generation"] = l.binding.Generation
	}
	if e = h.recordPermission(ctx, l, r); e != nil {
		return nil, e
	}
	return h.sendPermission(ctx, l, r)
}
func (h *NativeTrust) Recover(ctx context.Context, input map[string]any) (any, error) {
	l, e := h.capture(ctx)
	if e != nil {
		return nil, e
	}
	h.lane.Lock()
	defer h.lane.Unlock()
	action := text(input["action"])
	if action == "last-export" || action == "last-vc-export" {
		value, e := l.readKey(ctx, l.key("trust-package:"+action))
		if e != nil || value == nil {
			return value, e
		}
		last := psObject(value)
		container := psObject(last["container"])
		if action == "last-vc-export" {
			container = psObject(psObject(last["bundle"])["package"])
			if last["subjectId"] != l.scope.Owner || last["endpoint"] != h.runtime.store.Endpoint {
				return nil, nil
			}
		}
		manifest, e := trustParseText(container["manifestJson"])
		if e != nil {
			return nil, e
		}
		if manifest["subjectId"] != l.scope.Owner {
			return nil, nil
		}
		out := map[string]any{"packageId": last["packageId"], "createdAt": last["createdAt"], "remotePublished": false}
		if action == "last-export" {
			out["container"] = last["container"]
		} else {
			out["bundle"] = last["bundle"]
		}
		return out, l.check(ctx)
	}
	if action == "pending" {
		value, e := l.readKey(ctx, l.key("trust-package:pending"))
		if e != nil {
			return nil, e
		}
		if value != nil {
			if _, ok := value.([]any); !ok {
				return nil, connectionFailure("trust_operation_unavailable")
			}
		}
		out := []any{}
		for _, id := range trustArray(value) {
			r, e := h.loadPermission(ctx, l, text(id))
			if e != nil {
				return nil, e
			}
			if r["state"] != "acknowledged" {
				out = append(out, map[string]any{"operationId": id, "id": r["id"], "kind": r["kind"], "state": r["state"]})
			}
		}
		return out, l.check(ctx)
	}
	id := text(input["operationId"])
	if id == "" {
		return nil, connectionFailure("trust_operation_id_required")
	}
	r, e := h.loadPermission(ctx, l, id)
	if e != nil {
		return nil, e
	}
	receipt, e := h.reconcilePermission(ctx, l, r)
	if e != nil || receipt["state"] != "absent" {
		return receipt, e
	}
	if action == "reconcile" {
		return receipt, nil
	}
	if action == "stop-retry" {
		r["state"] = "stopped-local"
		if e = h.recordPermission(ctx, l, r); e != nil {
			return nil, e
		}
		return map[string]any{"state": "stopped-local", "id": r["id"], "operationId": id, "serverCancellationConfirmed": false, "lateReceiptCanBeReconciled": true}, nil
	}
	if action != "retry" {
		return nil, remoteFactsInvalid()
	}
	p, e := trustOriginal(r)
	if e != nil {
		return nil, e
	}
	reason := ""
	if psInt(p["expiresAt"]) <= h.now() {
		reason = "authorization-expired"
	} else if math.Abs(float64(psInt(p["issuedAt"])-h.now())) > 300 {
		reason = "original-signature-stale"
	} else if l.binding == nil || r["bindingId"] != l.binding.BindingID || r["keyId"] != l.keyID || psInt(r["epoch"]) != l.epoch {
		reason = "original-binding-changed"
	}
	if reason != "" {
		receipt["reason"] = reason
		return receipt, nil
	}
	if old := r["automaticRetryBlock"]; old != nil {
		r["rejections"] = append(trustArray(r["rejections"]), old)
		delete(r, "automaticRetryBlock")
	}
	return h.sendPermission(ctx, l, r)
}
