package native

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

type NativeA2a struct {
	runtime  *Runtime
	peers    []a2aPeer
	options  A2aOptions
	mu       sync.Mutex
	closed   bool
	previews map[string]*A2aPreview
}
type A2aPreview struct {
	host                       *NativeA2a
	peer                       a2aPeer
	lease                      *nativeIdentityLease
	journal                    *a2aJournal
	link                       map[string]any
	value                      map[string]any
	action, operationID, state string
	expires                    int64
	cancel                     context.CancelFunc
}

func NewNativeA2a(runtime *Runtime, rawConfiguration []byte, options A2aOptions) (*NativeA2a, error) {
	peers, e := a2aConfiguration(rawConfiguration)
	if e != nil {
		return nil, e
	}
	if options.Now == nil {
		options.Now = time.Now
	}
	return &NativeA2a{runtime: runtime, peers: peers, options: options, previews: map[string]*A2aPreview{}}, nil
}
func (h *NativeA2a) Peers() []any {
	out := []any{}
	for _, p := range h.peers {
		v := map[string]any{"id": p.id, "endpoint": p.endpoint, "trustExpiresAt": p.trustExpiresAt}
		if p.hasTenant {
			v["tenant"] = p.tenant
		}
		if p.hasName {
			v["name"] = p.name
		}
		out = append(out, v)
	}
	return out
}
func (h *NativeA2a) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for _, p := range h.previews {
		if p.cancel != nil {
			p.cancel()
		}
		p.state = "locally-stopped"
	}
	h.previews = map[string]*A2aPreview{}
}
func (h *NativeA2a) adapter(ctx context.Context, peerID string) (context.Context, func(), a2aPeer, *nativeIdentityLease, *a2aJournal, error) {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, nil, a2aPeer{}, nil, nil, a2aError("host closed")
	}
	var peer a2aPeer
	for _, p := range h.peers {
		if p.id == peerID {
			peer = p
			break
		}
	}
	if peer.id == "" {
		return nil, nil, peer, nil, nil, a2aError("select a configured peer")
	}
	operation, operationCancel, _, e := h.runtime.operation(ctx, true)
	if e != nil {
		return nil, nil, peer, nil, nil, e
	}
	op, leaseCancel, lease, e := h.runtime.identityLease(operation, false)
	cancel := func() { leaseCancel(); operationCancel() }
	if e != nil {
		operationCancel()
		return nil, nil, peer, nil, nil, e
	}
	fail := func(e error) (context.Context, func(), a2aPeer, *nativeIdentityLease, *a2aJournal, error) {
		cancel()
		return nil, nil, peer, nil, nil, e
	}
	if lease.connection.bindingID == "" {
		return fail(a2aError("current Native connection required"))
	}
	if _, e = peer.authorize(h.options.Now(), h.options.ReadEnvironment); e != nil {
		return fail(e)
	}
	j, e := newA2aJournal(h.runtime.store, peer.scope(lease.scope.Owner, h.runtime.config.Endpoint))
	if e != nil {
		return fail(e)
	}
	return op, cancel, peer, lease, j, nil
}
func a2aReaders(lease *nativeIdentityLease) a2aFactReaders {
	return a2aFactReaders{func(ctx context.Context, id string, input map[string]any) (map[string]any, error) {
		return lease.call(ctx, "/v2/cases/"+id+"/read", input, false)
	}, func(ctx context.Context, id string) (map[string]any, error) {
		return lease.call(ctx, "/v2/tasks/"+id, nil, false)
	}}
}
func (h *NativeA2a) access(ctx context.Context, p a2aPeer, l *nativeIdentityLease, link map[string]any, selected map[string]any) (string, map[string]any, map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return "", nil, nil, e
	}
	credential, e := p.authorize(h.options.Now(), h.options.ReadEnvironment)
	if e != nil {
		return "", nil, nil, e
	}
	current, facts, e := a2aReaders(l).resolve(ctx, text(link["caseId"]), text(link["attemptId"]), l.scope.Owner, selected, uploadObject(link["factContext"]))
	if e != nil {
		return "", nil, nil, e
	}
	if e = l.check(ctx); e != nil {
		return "", nil, nil, e
	}
	if _, e = p.authorize(h.options.Now(), h.options.ReadEnvironment); e != nil {
		return "", nil, nil, e
	}
	return credential, current, facts, nil
}
func a2aFinish(link map[string]any, outcome map[string]any) map[string]any {
	operations := uploadRows(link["operations"])
	if len(operations) > 0 {
		last := a2aClone(uploadObject(operations[len(operations)-1]))
		for k, v := range outcome {
			last[k] = v
		}
		copy := append([]any{}, operations...)
		copy[len(copy)-1] = last
		link["operations"] = copy
	}
	return link
}
func (h *NativeA2a) perform(ctx context.Context, p a2aPeer, l *nativeIdentityLease, j *a2aJournal, link map[string]any, kind, operationID, requestHash, credential string, params *protocol.OrderedObject) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	reserved, e := j.change(ctx, text(link["id"]), a2aInteger(link["revision"]), func(dir string) error { return h.guard(l, dir) }, func(previous map[string]any) (map[string]any, error) {
		operations := uploadRows(previous["operations"])
		if len(operations) >= 128 {
			return nil, a2aError("association operation limit reached")
		}
		next := a2aClone(link)
		op := map[string]any{"id": operationID, "kind": kind, "requestHash": requestHash, "at": h.options.Now().UnixMilli(), "outcome": "dispatching"}
		if message := params.Values()["message"]; message != nil {
			m := a2aObject(message)
			content := a2aProjection("message", message)
			clean := protocol.NewOrderedObject()
			for _, key := range content.Keys() {
				if key != "taskId" && key != "contextId" {
					clean.Set(key, content.Values()[key])
				}
			}
			raw, _ := protocol.EncodeJS(clean)
			var task, context any
			if text(m["taskId"]) != "" {
				task = m["taskId"]
			}
			if text(m["contextId"]) != "" {
				context = m["contextId"]
			}
			op["originalMessage"] = map[string]any{"messageId": m["messageId"], "contentHash": a2aHash(raw), "taskId": task, "contextId": context}
		}
		next["status"] = "dispatching"
		next["operations"] = append(append([]any{}, operations...), op)
		return next, nil
	})
	if e != nil {
		return nil, e
	}
	method := "SendMessage"
	if kind == "poll" {
		method = "GetTask"
	}
	if kind == "cancel" {
		method = "CancelTask"
	}
	var observed map[string]any
	if e = l.check(ctx); e == nil {
		var result any
		result, e = a2aRPC(ctx, h.options.Post, p.scope(l.scope.Owner, h.runtime.config.Endpoint).Endpoint, credential, method, params)
		if e == nil {
			e = l.check(ctx)
		}
		if e == nil {
			observed, e = a2aSnapshot(result, uploadObject(link["peer"]))
		}
	}
	if e == nil {
		return j.change(ctx, text(link["id"]), a2aInteger(reserved["revision"]), func(dir string) error { return h.guard(l, dir) }, func(previous map[string]any) (map[string]any, error) {
			next := a2aClone(previous)
			next["peer"] = observed
			next["status"] = "observed"
			return a2aFinish(next, map[string]any{"outcome": "observed", "state": observed["state"], "responseHash": observed["responseHash"]}), nil
		})
	}
	var peerError *a2aPeerError
	outcome := "unknown"
	var reason any
	if errors.As(e, &peerError) {
		outcome = "peer-error"
		reason = peerError.Reason
	}
	// Cancellation may end the request context, but the original reservation
	// still needs its local outcome. This cannot replace a newer revision or
	// write under a changed selected identity.
	saveCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	_, _ = j.change(saveCtx, text(link["id"]), a2aInteger(reserved["revision"]), func(dir string) error { return h.guard(l, dir) }, func(previous map[string]any) (map[string]any, error) {
		next := a2aClone(previous)
		next["status"] = outcome
		return a2aFinish(next, map[string]any{"outcome": outcome, "reason": reason}), nil
	})
	return nil, &A2aOperationError{AssociationID: text(link["id"]), Reason: text(reason)}
}

type A2aOperationError struct{ AssociationID, Reason string }

func (e *A2aOperationError) Error() string {
	if e.Reason != "" {
		return "A2A peer error: " + e.Reason
	}
	return "A2A outcome unknown; inspect retained association before another action"
}
func a2aTaskParams(tenant, id string, history *int) *protocol.OrderedObject {
	p := protocol.NewOrderedObject()
	if tenant != "" {
		p.Set("tenant", tenant)
	}
	p.Set("id", id)
	if history != nil {
		p.Set("historyLength", *history)
	}
	return p
}
func a2aMessageParams(tenant, selectedText, messageID string, peer map[string]any) *protocol.OrderedObject {
	message := protocol.NewOrderedObject()
	message.Set("messageId", messageID)
	if v := text(peer["contextId"]); v != "" {
		message.Set("contextId", v)
	}
	if v := text(peer["taskId"]); v != "" {
		message.Set("taskId", v)
	}
	message.Set("role", "ROLE_USER")
	part := protocol.NewOrderedObject()
	part.Set("text", selectedText)
	part.Set("mediaType", "text/plain")
	message.Set("parts", []any{part})
	config := protocol.NewOrderedObject()
	config.Set("acceptedOutputModes", []any{"text/plain", "application/json"})
	config.Set("historyLength", 0)
	config.Set("returnImmediately", true)
	p := protocol.NewOrderedObject()
	if tenant != "" {
		p.Set("tenant", tenant)
	}
	p.Set("message", message)
	p.Set("configuration", config)
	return p
}
func (h *NativeA2a) Poll(ctx context.Context, peerID, id string) (map[string]any, error) {
	ctx, cancel, p, l, j, e := h.adapter(ctx, peerID)
	if e != nil {
		return nil, e
	}
	defer cancel()
	link, e := j.get(ctx, id)
	if e != nil {
		return nil, e
	}
	credential, _, _, e := h.access(ctx, p, l, link, nil)
	if e != nil {
		return nil, e
	}
	task := text(uploadObject(link["peer"])["taskId"])
	if task == "" {
		return nil, a2aError("no observed peer Task ID; automatic recovery/resend unavailable")
	}
	zero := 0
	params := a2aTaskParams(p.tenant, task, &zero)
	raw, _ := protocol.EncodeJS(params)
	return h.perform(ctx, p, l, j, link, "poll", uuid.NewString(), a2aHash(raw), credential, params)
}
