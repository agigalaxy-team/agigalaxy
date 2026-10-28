package native

import (
	"context"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/trustpackages"
	"github.com/google/uuid"
	"strings"
	"sync"
	"unicode/utf8"
)

type nativeTrustPreview struct {
	lease         *nativeTrustLease
	value         map[string]any
	action, state string
	receipt       any
	expires       int64
}
type NativeTrust struct {
	runtime  *Runtime
	mu, lane sync.Mutex
	closed   bool
	previews map[string]*nativeTrustPreview
}

func NewNativeTrust(runtime *Runtime) *NativeTrust {
	return &NativeTrust{runtime: runtime, previews: map[string]*nativeTrustPreview{}}
}
func (h *NativeTrust) Close() { h.mu.Lock(); defer h.mu.Unlock(); h.closed = true; clear(h.previews) }
func trustArray(v any) []any  { a, _ := v.([]any); return a }
func trustJSON(v any) (map[string]any, error) {
	raw, e := jstext.EncodeJSON(v)
	if e != nil {
		return nil, e
	}
	out, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, e
	}
	return psObject(out), nil
}
func trustParseText(v any) (map[string]any, error) {
	var raw []byte
	switch v := v.(type) {
	case string:
		raw = []byte(v)
	case jstext.String:
		raw = []byte(v.Decoded())
	default:
		return nil, connectionFailure("invalid_trust_input")
	}
	out, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, e
	}
	return psObject(out), nil
}
func trustCanonical(v any) (string, error) { raw, e := identity.Canonical(v); return string(raw), e }
func trustCompact(token string) (map[string]any, map[string]any, string, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, nil, "", connectionFailure("trust_operation_unavailable")
	}
	decode := func(s string) ([]byte, error) {
		b, e := base64.RawURLEncoding.DecodeString(s)
		if e != nil || !utf8.Valid(b) {
			return nil, connectionFailure("trust_operation_unavailable")
		}
		return b, nil
	}
	a, e := decode(parts[0])
	if e != nil {
		return nil, nil, "", e
	}
	b, e := decode(parts[1])
	if e != nil {
		return nil, nil, "", e
	}
	header, e := connectionObject(a)
	if e != nil {
		return nil, nil, "", e
	}
	payload, e := connectionObject(b)
	return header, payload, string(b), e
}
func (h *NativeTrust) checkSources(ctx context.Context, l *nativeTrustLease, container map[string]any, vc bool) error {
	objects, e := trustParseText(psObject(container["files"])["objects.json"])
	if e != nil {
		return e
	}
	sources := trustArray(objects["sources"])
	if len(sources) == 0 {
		return nil
	}
	selections := []any{}
	for _, v := range sources {
		s := psObject(v)
		selected := map[string]any{"ref": s["ref"], "mode": s["mode"]}
		if p := psObject(s["permission"]); p != nil {
			_, payload, _, e := trustCompact(text(p["signed"]))
			if e != nil {
				return e
			}
			selected["permissionId"] = payload["id"]
		}
		selections = append(selections, selected)
	}
	checked, e := l.call(ctx, "/v2/trust-package/sources", map[string]any{"selections": selections, "audience": objects["audience"], "expiresAt": objects["expiresAt"]}, false)
	if e != nil {
		return e
	}
	items := trustArray(checked["items"])
	if len(items) != len(sources) {
		return connectionFailure("trust_source_changed")
	}
	for i, v := range items {
		item := psObject(v)
		snapshot := psObject(item["snapshot"])
		source := psObject(sources[i])
		if item["state"] != "available" || snapshot["sourceHash"] != source["sourceHash"] || snapshot["sourceState"] != source["sourceState"] || vc && snapshot["authorId"] != source["authorId"] {
			return connectionFailure("trust_source_changed")
		}
	}
	return l.check(ctx)
}
func (h *NativeTrust) Prepare(ctx context.Context, input map[string]any) (map[string]any, error) {
	h.mu.Lock()
	for id, p := range h.previews {
		if p.expires <= h.runtime.connection.now().UnixMilli() {
			delete(h.previews, id)
		}
	}
	full := len(h.previews) >= 64
	h.mu.Unlock()
	if full {
		return nil, connectionFailure("trust_preview_limit")
	}
	l, e := h.capture(ctx)
	if e != nil {
		return nil, e
	}
	action := text(input["action"])
	var value map[string]any
	switch action {
	case "package":
		if _, e = trustpackages.Parse("sources", map[string]any{"selections": input["selections"], "audience": input["audience"], "expiresAt": input["expiresAt"]}); e != nil {
			return nil, e
		}
		sources := []any{}
		if selections := trustArray(input["selections"]); len(selections) > 0 {
			response, e := l.call(ctx, "/v2/trust-package/sources", map[string]any{"selections": selections, "audience": input["audience"], "expiresAt": input["expiresAt"]}, false)
			if e != nil {
				return nil, e
			}
			for _, v := range trustArray(response["items"]) {
				item := psObject(v)
				if item["state"] != "available" {
					return map[string]any{"state": "sources-unavailable", "items": response["items"]}, nil
				}
				sources = append(sources, item["snapshot"])
			}
		}
		value, e = trustpackages.Prepare(map[string]any{"identity": l.identity, "keyId": l.keyID, "epoch": l.epoch, "audience": input["audience"], "issuedAt": h.now(), "expiresAt": input["expiresAt"], "claims": input["claims"], "sources": sources}, h.now())
	case "grant", "revoke":
		route := "preview"
		if action == "revoke" {
			route = "revoke-preview"
		}
		value, e = l.call(ctx, "/v2/trust-package/permissions/"+route, input["input"], false)
		if e == nil {
			if value["signatureType"] != "galaxy-trust-source-permission-v1+jws" {
				return nil, connectionFailure("trust_signature_type_changed")
			}
			p, err := trustParseText(value["payloadJson"])
			if err != nil {
				return nil, err
			}
			if _, err = trustpackages.ParsePermission(p); err != nil {
				return nil, err
			}
			if p["subjectId"] != l.scope.Owner || l.binding == nil || p["bindingId"] != l.binding.BindingID || p["endpoint"] != h.runtime.store.Endpoint || p["keyId"] != l.keyID || psInt(p["epoch"]) != l.epoch {
				return nil, connectionFailure("trust_signer_context_changed")
			}
		}
	case "vc-package":
		value, e = trustpackages.PrepareVC(psObject(input["package"]), h.now())
		if e != nil {
			return nil, e
		}
		manifest, e := trustParseText(psObject(value["package"])["manifestJson"])
		if e != nil {
			return nil, e
		}
		if manifest["subjectId"] != l.scope.Owner || manifest["keyId"] != l.keyID || psInt(manifest["epoch"]) != l.epoch {
			return nil, connectionFailure("trust_vc_signer_mismatch")
		}
		e = h.checkSources(ctx, l, psObject(value["package"]), true)
	default:
		return nil, remoteFactsInvalid()
	}
	if e != nil {
		return nil, e
	}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	shown, e := trustJSON(value)
	if e != nil {
		return nil, e
	}
	shown["state"] = "ready"
	id := uuid.NewString()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, connectionFailure("native_trust_closed")
	}
	h.previews[id] = &nativeTrustPreview{lease: l, value: value, action: action, state: "prepared", expires: h.runtime.connection.now().UnixMilli() + 300000}
	return map[string]any{"operationId": id, "state": "prepared", "preview": shown, "remoteSubmitted": false}, nil
}
func (h *NativeTrust) preview(ctx context.Context, id string) (*nativeTrustPreview, error) {
	h.mu.Lock()
	p := h.previews[id]
	if p != nil && p.expires <= h.runtime.connection.now().UnixMilli() {
		delete(h.previews, id)
		p = nil
	}
	h.mu.Unlock()
	if p == nil {
		return nil, connectionFailure("trust_preview_expired_or_identity_changed")
	}
	return p, p.lease.check(ctx)
}
func (h *NativeTrust) ExecuteReviewed(ctx context.Context, id string, expected *ChoiceScope) (any, error) {
	p, e := h.preview(ctx, id)
	if e != nil {
		return nil, e
	}
	if expected == nil || *expected != p.lease.scope {
		return nil, connectionFailure("trust_identity_changed")
	}
	h.lane.Lock()
	defer h.lane.Unlock()
	if e = p.lease.check(ctx); e != nil {
		return nil, e
	}
	h.mu.Lock()
	if p.state != "prepared" {
		state, receipt := p.state, p.receipt
		h.mu.Unlock()
		return map[string]any{"operationId": id, "state": state, "receipt": receipt, "retryWith": "galaxy_trust_native_recover"}, nil
	}
	p.state = "running"
	h.mu.Unlock()
	var receipt any
	switch p.action {
	case "package":
		if e = h.checkSources(ctx, p.lease, p.value, false); e == nil {
			var signature string
			signature, e = p.lease.sign(ctx, text(p.value["manifestJson"]), "galaxy-trust-package-v1+jws")
			if e == nil {
				var container map[string]any
				container, e = trustpackages.Seal(p.value, signature, h.now())
				if e == nil {
					e = p.lease.putKey(ctx, p.lease.key("trust-package:last-export"), map[string]any{"packageId": p.value["packageId"], "createdAt": h.now(), "container": container})
					if e == nil {
						receipt, e = h.writeExport(ctx, p.lease, container, nil)
					}
				}
			}
		}
	case "vc-package":
		if e = h.checkSources(ctx, p.lease, psObject(p.value["package"]), true); e == nil {
			var signature string
			signature, e = p.lease.signVC(ctx, p.value)
			if e == nil {
				var bundle map[string]any
				bundle, e = trustpackages.SealVC(p.value, signature, h.now())
				if e == nil {
					e = p.lease.putKey(ctx, p.lease.key("trust-package:last-vc-export"), map[string]any{"subjectId": p.lease.scope.Owner, "endpoint": h.runtime.store.Endpoint, "packageId": p.value["packageId"], "createdAt": h.now(), "bundle": bundle})
					if e == nil {
						receipt, e = h.writeExport(ctx, p.lease, psObject(bundle["package"]), bundle)
					}
				}
			}
		}
	default:
		receipt, e = h.executePermission(ctx, p.lease, p.value)
	}
	if e == nil {
		e = p.lease.check(ctx)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if e != nil {
		p.state = "original-operation-needs-reconciliation"
		return nil, e
	}
	p.state = "completed"
	p.receipt = receipt
	return receipt, nil
}
func (h *NativeTrust) Cancel(ctx context.Context, id string) (any, error) {
	p, e := h.preview(ctx, id)
	if e != nil {
		return nil, e
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if p.state != "prepared" {
		return map[string]any{"state": p.state, "serverCancellationConfirmed": false, "retryWith": "galaxy_trust_native_recover"}, nil
	}
	delete(h.previews, id)
	return map[string]any{"state": "canceled-before-signing", "sideEffect": false}, nil
}
