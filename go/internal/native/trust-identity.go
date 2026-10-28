package native

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/trustpackages"
	"io"
	"os"
	"path/filepath"
)

type nativeTrustLease struct {
	host       *NativeTrust
	scope      ChoiceScope
	generation uint64
	binding    *ConnectionSnapshot
	identity   map[string]any
	keyID      string
	epoch      int64
}
type nativeTrustMaterial struct {
	subject      string
	proof        map[string]any
	key          ed25519.PrivateKey
	public       string
	localGenesis bool
}

func (h *NativeTrust) now() int64 { return h.runtime.connection.now().Unix() }
func (l *nativeTrustLease) checkReference(ctx context.Context) error {
	l.host.mu.Lock()
	closed := l.host.closed
	l.host.mu.Unlock()
	if closed {
		return connectionFailure("native_trust_closed")
	}
	if e := ctx.Err(); e != nil {
		return e
	}
	if e := l.host.runtime.checkOperation(l.generation); e != nil {
		return e
	}
	scope, e := l.host.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return e
	}
	if scope != l.scope {
		return connectionFailure("trust_identity_changed")
	}
	current, e := l.host.runtime.connection.Snapshot(ctx)
	if e != nil {
		return e
	}
	if (current == nil) != (l.binding == nil) {
		return connectionFailure("trust_identity_changed")
	}
	if current != nil && (current.SubjectID != l.scope.Owner || current.BindingID != l.binding.BindingID || current.Generation != l.binding.Generation || current.Endpoint != l.binding.Endpoint) {
		return connectionFailure("trust_identity_changed")
	}
	return nil
}
func (l *nativeTrustLease) material(ctx context.Context) (nativeTrustMaterial, error) {
	var out nativeTrustMaterial
	r := l.host.runtime
	selected, e := r.connection.lease(ctx, false)
	if e != nil {
		return out, e
	}
	if active := selected.selection.Active; active != nil {
		out.subject = active.SubjectID
		out.proof = active.GenesisProof
		out.key, out.public, e = r.connection.deviceKey(ctx, selected)
	} else {
		out.localGenesis = true
		e = r.store.With(ctx, false, func(dir string) error {
			if e := r.store.verifyChoiceWithin(dir, &l.scope); e != nil {
				return e
			}
			var local map[string]any
			if e := readFallback(dir, "galaxy-id.json", "node.json", &local); e != nil {
				return e
			}
			out.subject = text(local["id"])
			out.proof = psObject(local["genesisProof"])
			f, e := os.Open(filepath.Join(dir, "galaxy-id-private-key.pem"))
			if e != nil {
				return connectionFailure("trust_identity_required")
			}
			defer f.Close()
			raw, e := io.ReadAll(io.LimitReader(f, 4097))
			if e != nil || len(raw) > 4096 {
				return connectionFailure("trust_identity_required")
			}
			out.key, e = identity.PrivatePEM(raw)
			if e != nil {
				return e
			}
			out.public, e = identity.PublicPEM(out.key.Public().(ed25519.PublicKey))
			return e
		})
	}
	if e != nil {
		return out, e
	}
	if out.subject == "" || out.subject != l.scope.Owner || out.public == "" {
		return out, connectionFailure("trust_identity_required")
	}
	return out, l.checkReference(ctx)
}
func (l *nativeTrustLease) key(name string) string {
	return "native-trust:" + l.host.runtime.store.Endpoint + ":" + l.scope.Owner + ":" + name
}
func (l *nativeTrustLease) readKey(ctx context.Context, key string) (any, error) {
	if e := l.checkReference(ctx); e != nil {
		return nil, e
	}
	var out any
	e := l.host.runtime.store.With(ctx, false, func(dir string) error {
		if e := l.host.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		_, e := readJSON(connectionRecordPath(dir, key), &out)
		return e
	})
	if e != nil {
		return nil, e
	}
	return out, l.checkReference(ctx)
}
func (l *nativeTrustLease) putKey(ctx context.Context, key string, value any) error {
	if e := l.checkReference(ctx); e != nil {
		return e
	}
	e := l.host.runtime.store.With(ctx, true, func(dir string) error {
		if e := l.host.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		return uploadNativeRecordWithin(dir, key, value)
	})
	if e != nil {
		return e
	}
	return l.checkReference(ctx)
}
func (l *nativeTrustLease) current(ctx context.Context) (map[string]any, nativeTrustMaterial, error) {
	if e := l.checkReference(ctx); e != nil {
		return nil, nativeTrustMaterial{}, e
	}
	material, e := l.material(ctx)
	if e != nil {
		return nil, material, e
	}
	cached, e := l.readKey(ctx, "native-trust-identity:"+l.host.runtime.store.Endpoint+":"+material.subject)
	if e != nil {
		return nil, material, e
	}
	doc := psObject(cached)
	if doc == nil {
		if !material.localGenesis {
			return nil, material, connectionFailure("trust_identity_snapshot_required")
		}
		doc = map[string]any{"subjectId": material.subject, "genesisProof": material.proof, "events": []any{}, "authority": nil, "checkedAt": l.host.now()}
	}
	if doc["subjectId"] != material.subject || doc["authority"] != nil && doc["authority"] != l.host.runtime.store.Endpoint {
		return nil, material, connectionFailure("trust_identity_authority_changed")
	}
	if _, e = trustpackages.ParseIdentity(doc); e != nil {
		return nil, material, e
	}
	state, e := trustpackages.VerifyPortableIdentity(doc)
	if e != nil {
		return nil, material, e
	}
	keyID := identity.Digest([]byte(material.public))
	found := false
	for _, v := range trustArray(state["devices"]) {
		d := psObject(v)
		if d["keyId"] == keyID && d["publicKey"] == material.public && psInt(d["epoch"]) == psInt(state["epoch"]) {
			found = true
		}
	}
	if !found {
		return nil, material, connectionFailure("trust_device_not_in_cached_control")
	}
	if l.keyID != "" && (l.keyID != keyID || l.epoch != psInt(state["epoch"])) {
		return nil, material, connectionFailure("trust_identity_changed")
	}
	l.keyID = keyID
	l.epoch = psInt(state["epoch"])
	l.identity = doc
	out := map[string]any{"identity": doc, "keyId": keyID, "epoch": l.epoch, "bindingId": nil, "generation": nil, "endpoint": l.host.runtime.store.Endpoint}
	if l.binding != nil {
		out["bindingId"] = l.binding.BindingID
		out["generation"] = l.binding.Generation
	}
	return out, material, l.checkReference(ctx)
}
func (h *NativeTrust) baseLease(ctx context.Context) (*nativeTrustLease, error) {
	op, cancel, generation, e := h.runtime.operation(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	scope, e := h.runtime.store.ChoiceScope(op)
	if e != nil {
		return nil, e
	}
	if scope.Owner == "" {
		return nil, connectionFailure("trust_identity_required")
	}
	binding, e := h.runtime.connection.Snapshot(op)
	if e != nil {
		return nil, e
	}
	l := &nativeTrustLease{host: h, scope: scope, generation: generation, binding: binding}
	return l, l.checkReference(op)
}
func (h *NativeTrust) capture(ctx context.Context) (*nativeTrustLease, error) {
	l, e := h.baseLease(ctx)
	if e != nil {
		return nil, e
	}
	_, _, e = l.current(ctx)
	return l, e
}
func (l *nativeTrustLease) check(ctx context.Context) error { _, _, e := l.current(ctx); return e }
func (l *nativeTrustLease) call(ctx context.Context, path string, input any, public bool) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	if !public && l.binding == nil {
		return nil, connectionFailure("trust_connection_required")
	}
	method := "POST"
	if input == nil {
		method = "GET"
	}
	out, e := l.host.runtime.Call(ctx, path, input, ConnectionCallOptions{Method: method, Unauthenticated: public, ExpectedScope: &l.scope})
	if check := l.check(ctx); check != nil {
		return nil, check
	}
	return out, e
}
func (l *nativeTrustLease) sign(ctx context.Context, payload, kind string) (string, error) {
	if kind != "galaxy-trust-package-v1+jws" && kind != "galaxy-trust-source-permission-v1+jws" {
		return "", connectionFailure("trust_signature_type_forbidden")
	}
	_, material, e := l.current(ctx)
	if e != nil {
		return "", e
	}
	signed, e := identity.SignIdentityPayload(material.key, payload, kind)
	if e != nil {
		return "", e
	}
	return signed, l.check(ctx)
}
func (l *nativeTrustLease) signVC(ctx context.Context, preview map[string]any) (string, error) {
	return trustpackages.SignVC(preview, l.host.now(), func(payload string, header map[string]any) (string, error) {
		_, material, e := l.current(ctx)
		if e != nil {
			return "", e
		}
		ordered := protocol.NewOrderedObject()
		for _, k := range []string{"alg", "typ", "cty", "kid"} {
			ordered.Set(k, header[k])
		}
		raw, e := protocol.EncodeJS(ordered)
		if e != nil {
			return "", e
		}
		b64 := base64.RawURLEncoding.EncodeToString
		input := b64(raw) + "." + b64([]byte(payload))
		signed := input + "." + b64(ed25519.Sign(material.key, []byte(input)))
		return signed, l.check(ctx)
	})
}
func (h *NativeTrust) refresh(ctx context.Context) (any, error) {
	l, e := h.baseLease(ctx)
	if e != nil {
		return nil, e
	}
	before, e := l.material(ctx)
	if e != nil {
		return nil, e
	}
	state, e := h.runtime.Call(ctx, "/v2/identity/"+l.scope.Owner+"/control", nil, ConnectionCallOptions{Method: "GET", Unauthenticated: true, ExpectedScope: &l.scope})
	if e != nil {
		return nil, e
	}
	if e = l.checkReference(ctx); e != nil {
		return nil, e
	}
	if state["authority"] != h.runtime.store.Endpoint || !psSafeInteger(state["checkedAt"]) || psInt(state["checkedAt"]) < 0 {
		return nil, connectionFailure("trust_identity_authority_changed")
	}
	doc := map[string]any{"subjectId": state["subjectId"], "genesisProof": state["genesisProof"], "events": state["events"], "authority": state["authority"], "checkedAt": state["checkedAt"]}
	if _, e = trustpackages.ParseIdentity(doc); e != nil {
		return nil, e
	}
	current, e := trustpackages.VerifyPortableIdentity(doc)
	if e != nil {
		return nil, e
	}
	if psInt(current["epoch"]) != psInt(state["epoch"]) {
		return nil, connectionFailure("trust_identity_epoch_mismatch")
	}
	previous, e := l.readKey(ctx, "native-trust-identity:"+h.runtime.store.Endpoint+":"+l.scope.Owner)
	if e != nil {
		return nil, e
	}
	if previous != nil {
		if _, e = trustpackages.ParseIdentity(psObject(previous)); e != nil {
			return nil, e
		}
		prior, e := trustpackages.VerifyPortableIdentity(psObject(previous))
		if e != nil {
			return nil, e
		}
		if psInt(prior["sequence"]) > psInt(current["sequence"]) || psInt(prior["sequence"]) == psInt(current["sequence"]) && prior["chainHead"] != current["chainHead"] {
			return nil, connectionFailure("trust_identity_snapshot_rollback")
		}
	}
	if e = l.putKey(ctx, "native-trust-identity:"+h.runtime.store.Endpoint+":"+l.scope.Owner, doc); e != nil {
		return nil, e
	}
	// A deliberate refresh may advance epoch/key eligibility; return the fresh
	// context, while every already prepared operation keeps its older fence.
	after, e := l.material(ctx)
	if e != nil {
		return nil, e
	}
	if before.subject != after.subject || before.public != after.public {
		return nil, connectionFailure("trust_identity_changed")
	}
	l.keyID = ""
	out, _, e := l.current(ctx)
	return out, e
}
