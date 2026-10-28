package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

// LocalStatus follows the original status-only observer: no device selection,
// session restoration, host driver, timer or model is needed to read locators.
func (h *NativeWatchRuntime) LocalStatus(ctx context.Context, id string) (map[string]any, error) {
	operation, cancel, generation, e := h.runtime.operation(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	scope, e := h.runtime.store.ChoiceScope(operation)
	if e != nil {
		return nil, e
	}
	if scope.Owner == "" {
		return nil, watchFailure("native_identity_required")
	}
	var state map[string]any
	order := []string{}
	e = h.runtime.store.With(operation, false, func(dir string) error {
		if e := h.runtime.store.verifyChoiceWithin(dir, &scope); e != nil {
			return e
		}
		var raw json.RawMessage
		exists, e := readJSON(connectionRecordPath(dir, "native-watch:"+scope.Endpoint+":"+scope.Owner), &raw)
		if e != nil {
			return e
		}
		state = map[string]any{"version": 1, "watches": map[string]any{}}
		if !exists || string(raw) == "null" {
			return nil
		}
		state, e = connectionObject(raw)
		if e != nil {
			return e
		}
		wire, e := protocol.DecodeOrdered(raw)
		if e != nil {
			return e
		}
		root, ok := wire.(*protocol.OrderedObject)
		if !ok {
			return watchFailure("native_record_invalid")
		}
		watches, ok := root.Values()["watches"].(*protocol.OrderedObject)
		if !ok {
			return watchFailure("native_record_invalid")
		}
		order = watches.Keys()
		return nil
	})
	if e != nil {
		return nil, e
	}
	if e = h.runtime.checkOperation(generation); e != nil {
		return nil, e
	}
	return h.projectStatus(h.watch.projectStatus(state, order, id), scope.Owner), nil
}
