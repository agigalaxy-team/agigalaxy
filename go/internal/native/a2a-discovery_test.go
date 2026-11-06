package native

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func TestDiscoveredPeerAndOriginalTaskSurviveHostRestart(t *testing.T) {
	ctx := context.Background()
	store, _ := fixture(t)
	r := commandRuntime(t, store)
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	card := protocol.NewOrderedObject()
	card.Set("supportedInterfaces", []any{map[string]any{"url": "https://peer.invalid/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}})
	raw, _ := protocol.EncodeJS(card)
	p := a2aPeer{id: "builder_selected", name: "Selected Agent", endpoint: "https://peer.invalid/a2a", principal: "selected-node", card: card, cardHash: a2aHash(raw), authMode: "none", trustExpiresAt: time.Now().Add(time.Minute).UnixMilli(), source: map[string]any{"kind": "builder", "builderId": "00000000-0000-4000-8000-000000000001", "checkedAt": time.Now().UnixMilli()}, owner: scope.Owner, official: scope.Endpoint, hasName: true}
	j, e := newA2aJournal(store, p.scope(scope.Owner, scope.Endpoint))
	if e != nil {
		t.Fatal(e)
	}
	if e = store.With(ctx, true, func(dir string) error {
		return j.save(dir, map[string]any{"version": 1, "scopeHash": j.scopeHash, "peer": p.record(), "links": []any{map[string]any{"id": "original-association", "revision": 1, "source": map[string]any{"kind": "local-work", "workId": "original-work"}, "peer": map[string]any{"taskId": "actual-peer-task", "state": "input-required"}, "operations": []any{map[string]any{"id": "original-operation", "outcome": "observed"}}}}})
	}); e != nil {
		t.Fatal(e)
	}
	restarted, e := NewNativeA2a(r, nil, A2aOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer restarted.Close()
	peers := restarted.Peers()
	if len(peers) != 1 || uploadObject(peers[0])["id"] != p.id {
		t.Fatal("restart lost the selected endpoint", peers)
	}
	retained, e := newA2aJournal(store, restarted.peers[0].scope(scope.Owner, scope.Endpoint))
	if e != nil {
		t.Fatal(e)
	}
	link, e := retained.get(ctx, "original-association")
	if e != nil || uploadObject(link["peer"])["taskId"] != "actual-peer-task" || uploadObject(uploadRows(link["operations"])[0])["id"] != "original-operation" {
		t.Fatal("restart replaced original Task or operation", link, e)
	}
}

func TestA2aCardAuthenticationRequirementIsNotCallableAsPublic(t *testing.T) {
	if !a2aCardRequiresAuthentication(map[string]any{"securityRequirements": []any{map[string]any{"schemes": map[string]any{"bearer": []any{}}}}}) {
		t.Fatal("advertised authentication was treated as anonymous")
	}
	if a2aCardRequiresAuthentication(map[string]any{"securityRequirements": []any{map[string]any{}}}) {
		t.Fatal("anonymous alternative was ignored")
	}
	if a2aCardRequiresAuthentication(map[string]any{"securityRequirements": []any{map[string]any{"schemes": map[string]any{}}}}) {
		t.Fatal("A2A 1.0 empty schemes alternative was ignored")
	}
}
