package native

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
)

func a2aCardRequiresAuthentication(card map[string]any) bool {
	for _, key := range []string{"securityRequirements", "security_requirements", "security"} {
		if value, exists := card[key]; exists {
			rows, ok := value.([]any)
			if !ok {
				return true
			}
			if len(rows) == 0 {
				return false
			}
			for _, raw := range rows {
				if item := a2aObject(raw); item != nil {
					if len(item) == 0 {
						return false // An advertised anonymous alternative.
					}
					if schemes := a2aObject(item["schemes"]); key != "security" && schemes != nil && len(schemes) == 0 {
						return false // A2A 1.0 wraps scheme names in `schemes`.
					}
				}
			}
			return true
		}
	}
	return false
}

func (h *NativeA2a) Resolve(ctx context.Context, input any) (map[string]any, error) {
	value, e := a2aNormalize("galaxy_a2a_resolve", input)
	if e != nil {
		return nil, e
	}
	ctx, cancel, l, e := h.runtime.identityLease(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	_, view, e := h.resolveBuilder(ctx, l, text(value["builderId"]))
	return view, e
}

func (h *NativeA2a) resolveBuilder(ctx context.Context, l *nativeIdentityLease, id string) (a2aPeer, map[string]any, error) {
	var none a2aPeer
	current, e := l.call(ctx, "/v1/builders/read", map[string]any{"builderId": id}, false)
	if e != nil {
		return none, nil, e
	}
	declaration := uploadObject(current["declaration"])
	target := uploadObject(declaration["a2a"])
	if current["builderId"] != id || current["type"] != "worker" || current["delisted"] == true || current["securityIssue"] == true || target["protocol"] != "a2a/1.0" || target["transport"] != "JSONRPC" || !publicfetch.ValidURL(text(target["cardUrl"])) || !publicfetch.ValidURL(text(target["endpoint"])) || !helpSubject.MatchString(text(declaration["nodeId"])) {
		return none, nil, a2aError("selected Builder has no currently readable supported A2A interface")
	}
	get := h.options.GetCard
	if get == nil {
		get = publicfetch.GetA2ACard
	}
	raw, e := get(ctx, text(target["cardUrl"]), 65536, 10*time.Second)
	if e != nil {
		return none, nil, e
	}
	if e = l.check(ctx); e != nil {
		return none, nil, e
	}
	parsed, e := protocol.DecodeOrdered(raw)
	card, ok := parsed.(*protocol.OrderedObject)
	if e != nil || !ok {
		return none, nil, a2aError("actual AgentCard is not a JSON object")
	}
	wire, e := protocol.EncodeJS(card)
	if e != nil {
		return none, nil, e
	}
	source := map[string]any{"kind": "builder", "builderId": id, "declarationId": current["declarationId"], "declarationHash": current["declarationHash"], "cardUrl": target["cardUrl"], "checkedAt": h.options.Now().UnixMilli()}
	principal := text(declaration["nodeId"])
	key, _ := protocol.EncodeJS([]any{l.scope.Owner, l.scope.Endpoint, id, target["endpoint"], target["tenant"], principal})
	p := a2aPeer{id: "builder_" + a2aHash(key), name: text(declaration["name"]), endpoint: text(target["endpoint"]), tenant: text(target["tenant"]), principal: principal, card: card, cardHash: a2aHash(wire), authMode: "none", trustExpiresAt: h.options.Now().Add(5 * time.Minute).UnixMilli(), hasName: true, hasTenant: true, source: source, owner: l.scope.Owner, official: l.scope.Endpoint}
	// Interface validation uses the same configured-peer validator. It sends
	// no task or probe, and does not claim endpoint control or capability.
	if _, e = p.authorize(h.options.Now(), h.options.ReadEnvironment); e != nil {
		return none, nil, e
	}
	view := map[string]any{"state": "available", "peerId": p.id, "name": p.name, "endpoint": p.endpoint, "tenant": p.tenant, "source": source, "authenticationRequired": false, "capabilityVerified": false, "endpointControlVerified": false, "remoteSubmitted": false, "interpretation": "actual-card-interface-observed; selected-text-dispatch-still-requires-native-choice"}
	if a2aCardRequiresAuthentication(card.Values()) {
		view["state"] = "authentication-required"
		view["authenticationRequired"] = true
		delete(view, "peerId")
		view["authentication"] = map[string]any{"securitySchemes": card.Values()["securitySchemes"], "securityRequirements": card.Values()["securityRequirements"], "availableThrough": "existing-explicit-peer-authentication-configuration"}
		return none, view, nil
	}
	if e = h.rememberDiscovered(ctx, l, p); e != nil {
		return none, nil, e
	}
	return p, view, nil
}

func (h *NativeA2a) checkDiscovered(ctx context.Context, l *nativeIdentityLease, p a2aPeer) error {
	current, e := l.call(ctx, "/v1/builders/read", map[string]any{"builderId": p.source["builderId"]}, false)
	if e != nil {
		return e
	}
	declaration := uploadObject(current["declaration"])
	target := uploadObject(declaration["a2a"])
	if current["declarationId"] != p.source["declarationId"] || current["declarationHash"] != p.source["declarationHash"] || current["delisted"] == true || current["securityIssue"] == true || target["endpoint"] != p.endpoint || text(target["tenant"]) != p.tenant || declaration["nodeId"] != p.principal {
		return a2aError("selected Builder declaration changed; resolve its current interface before another dispatch")
	}
	return l.check(ctx)
}

func (p a2aPeer) record() map[string]any {
	return map[string]any{"scope": p.scope(p.owner, p.official), "source": p.source, "configuration": map[string]any{"id": p.id, "name": p.name, "endpoint": p.endpoint, "tenant": p.tenant, "peerPrincipal": p.principal, "agentCard": p.card, "cardHash": p.cardHash, "trustExpiresAt": p.trustExpiresAt, "authentication": map[string]any{"mode": p.authMode}}}
}

func (h *NativeA2a) rememberDiscovered(ctx context.Context, l *nativeIdentityLease, p a2aPeer) error {
	j, e := newA2aJournal(h.runtime.store, p.scope(l.scope.Owner, l.scope.Endpoint))
	if e != nil {
		return e
	}
	e = j.store.With(ctx, true, func(dir string) error {
		if e := h.guard(l, dir); e != nil {
			return e
		}
		data, e := j.load(dir)
		if e != nil {
			return e
		}
		data["peer"] = p.record()
		return j.save(dir, data)
	})
	if e != nil {
		return e
	}
	h.keepDiscovered(p)
	return l.check(ctx)
}

func (h *NativeA2a) keepDiscovered(p a2aPeer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i, old := range h.peers {
		if old.id == p.id {
			if old.source != nil && a2aInteger(old.source["checkedAt"]) <= a2aInteger(p.source["checkedAt"]) {
				h.peers[i] = p
			}
			return
		}
	}
	h.peers = append(h.peers, p)
}

// Discovery metadata lives beside the original associations in their original
// owner/endpoint/peer-scoped journal. Restarting does not lose active Task IDs.
func (h *NativeA2a) restoreDiscovered(ctx context.Context) error {
	scope, e := h.runtime.store.ChoiceScope(ctx)
	if e != nil || scope.Owner == "" {
		return e
	}
	peers := []a2aPeer{}
	e = h.runtime.store.With(ctx, false, func(dir string) error {
		entries, e := os.ReadDir(dir)
		if errors.Is(e, os.ErrNotExist) {
			return nil
		}
		if e != nil {
			return e
		}
		for _, file := range entries {
			if file.IsDir() || !strings.HasPrefix(file.Name(), "a2a-") || !strings.HasSuffix(file.Name(), ".json") {
				continue
			}
			hash := strings.TrimSuffix(strings.TrimPrefix(file.Name(), "a2a-"), ".json")
			if !helpDigest.MatchString(hash) {
				continue
			}
			j := &a2aJournal{store: h.runtime.store, scopeHash: hash}
			data, e := j.load(dir)
			if e != nil {
				return e
			}
			meta := uploadObject(data["peer"])
			savedScope := uploadObject(meta["scope"])
			if savedScope["subjectId"] != scope.Owner || savedScope["officialEndpoint"] != scope.Endpoint {
				continue
			}
			raw, e := protocol.EncodeJS(map[string]any{"peers": []any{meta["configuration"]}})
			if e != nil {
				return e
			}
			parsed, e := a2aConfiguration(raw)
			if e != nil || len(parsed) != 1 {
				return a2aError("retained peer metadata is invalid")
			}
			p := parsed[0]
			p.owner, p.official, p.source = scope.Owner, scope.Endpoint, uploadObject(meta["source"])
			expected, _ := newA2aJournal(h.runtime.store, p.scope(p.owner, p.official))
			if p.source == nil || p.source["kind"] != "builder" || !controlUUID(p.source["builderId"]) || expected.scopeHash != hash {
				return a2aError("retained peer source does not match its original journal")
			}
			peers = append(peers, p)
		}
		return nil
	})
	if e != nil {
		return e
	}
	for _, p := range peers {
		h.keepDiscovered(p)
	}
	return nil
}
