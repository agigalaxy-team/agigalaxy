package native

import (
	"context"
	"errors"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// NativeBookmarkSetter retains only the selected reference and the original
// command. A lost response never becomes a second, newly numbered save.
type NativeBookmarkSetter struct {
	runtime *Runtime
	mu      sync.Mutex
	queues  map[string]*bookmarkQueue
}
type bookmarkQueue struct {
	token chan struct{}
	users int
}

func NewNativeBookmarkSetter(r *Runtime) *NativeBookmarkSetter {
	return &NativeBookmarkSetter{runtime: r, queues: map[string]*bookmarkQueue{}}
}
func bookmarkContracts() map[string]any {
	var v map[string]any
	_ = protocol.Decode([]byte(bookmarkContractsJSON), &v)
	return v
}
func bookmarkValidate(kind string, value any) error {
	if remoteChatValidate(uploadObject(bookmarkContracts()[kind]), value) != nil {
		return connectionFailure("reading_bookmark_local_record_invalid")
	}
	return nil
}
func bookmarkReference(v map[string]any) (*protocol.OrderedObject, string) {
	kind := text(v["kind"])
	keys := map[string][]string{"forum-post": {"postId"}, "capsule": {"capsuleId", "versionId"}, "project": {"projectId"}, "person": {"subjectId"}, "chat-message": {"roomId", "messageId"}}[kind]
	out := protocol.NewOrderedObject()
	out.Set("kind", kind)
	key := kind
	for _, k := range keys {
		out.Set(k, v[k])
		key += ":" + text(v[k])
	}
	return out, key
}
func bookmarkCommand(v map[string]any) (*protocol.OrderedObject, string, error) {
	if e := bookmarkValidate("command", v); e != nil {
		return nil, "", e
	}
	ref, key := bookmarkReference(uploadObject(v["reference"]))
	o := protocol.NewOrderedObject()
	o.Set("operationId", v["operationId"])
	o.Set("reference", ref)
	o.Set("saved", v["saved"])
	o.Set("expectedRevision", v["expectedRevision"])
	return o, key, nil
}
func bookmarkClientError(e error) bool {
	status := fault.Status(e)
	var h *ConnectionHTTPError
	if errors.As(e, &h) {
		status = h.Status
	}
	return status >= 400 && status < 500
}
func (h *NativeBookmarkSetter) lock(ctx context.Context, key string) (func(), error) {
	h.mu.Lock()
	q := h.queues[key]
	if q == nil {
		q = &bookmarkQueue{token: make(chan struct{}, 1)}
		q.token <- struct{}{}
		h.queues[key] = q
	}
	q.users++
	h.mu.Unlock()
	releaseUser := func() {
		h.mu.Lock()
		q.users--
		if q.users == 0 {
			delete(h.queues, key)
		}
		h.mu.Unlock()
	}
	select {
	case <-ctx.Done():
		releaseUser()
		return nil, ctx.Err()
	case <-q.token:
		return func() { q.token <- struct{}{}; releaseUser() }, nil
	}
}
func (h *NativeBookmarkSetter) Change(ctx context.Context, input any) (map[string]any, error) {
	if e := bookmarkValidate("input", input); e != nil {
		return nil, e
	}
	selected := uploadObject(input)
	operation, cancel, l, e := h.runtime.identityLease(ctx, true)
	if e != nil {
		return nil, e
	}
	defer cancel()
	ctx = operation
	_, referenceKey := bookmarkReference(uploadObject(selected["reference"]))
	key := "native-bookmark:" + l.scope.Endpoint + ":" + l.scope.Owner + ":" + referenceKey
	unlock, e := h.lock(ctx, key)
	if e != nil {
		return nil, e
	}
	defer unlock()
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	call := func(action string, value any) (map[string]any, error) {
		return l.call(ctx, "/v2/reading-bookmarks/"+action, value, false)
	}
	current := func() (map[string]any, error) {
		v, e := call("status", map[string]any{"reference": selected["reference"]})
		if e != nil {
			return nil, e
		}
		if e = bookmarkValidate("state", v); e != nil {
			return nil, e
		}
		_, k := bookmarkReference(uploadObject(v["reference"]))
		if k != referenceKey {
			return nil, connectionFailure("reading_bookmark_reference_mismatch")
		}
		return v, nil
	}
	clear := func(id string) error {
		return l.update(ctx, key, func(prior map[string]any) (map[string]any, error) {
			if text(uploadObject(prior["command"])["operationId"]) == id {
				return nil, nil
			}
			return prior, nil
		})
	}
	finish := func(row map[string]any, alreadySent bool) (map[string]any, error) {
		command := uploadObject(row["command"])
		ordered, k, e := bookmarkCommand(command)
		if e != nil {
			return nil, e
		}
		raw, e := protocol.EncodeJS(ordered)
		if e != nil {
			return nil, e
		}
		if k != referenceKey || identity.Digest(raw) != row["payloadHash"] {
			return nil, connectionFailure("reading_bookmark_local_record_invalid")
		}
		checked := func(v map[string]any, e error) (map[string]any, error) {
			if e != nil {
				return nil, e
			}
			if e = bookmarkValidate("receipt", v); e != nil {
				return nil, e
			}
			if v["operationId"] != command["operationId"] || v["payloadHash"] != row["payloadHash"] {
				return nil, connectionFailure("reading_bookmark_receipt_mismatch")
			}
			if v["state"] == "acknowledged" {
				_, rk := bookmarkReference(uploadObject(uploadObject(v["bookmark"])["reference"]))
				if rk != k {
					return nil, connectionFailure("reading_bookmark_receipt_mismatch")
				}
			}
			return v, nil
		}
		receiptInput := map[string]any{"operationId": command["operationId"], "payloadHash": row["payloadHash"]}
		var receipt map[string]any
		if alreadySent {
			receipt = map[string]any{"state": "absent"}
		} else {
			receipt, e = checked(call("receipt", receiptInput))
		}
		if e == nil && receipt["state"] == "absent" {
			receipt, e = checked(call("command", ordered))
			if e != nil && !bookmarkClientError(e) {
				original := e
				receipt, e = checked(call("receipt", receiptInput))
				if e == nil && receipt["state"] != "acknowledged" {
					e = original
				}
			}
		}
		if e == nil && receipt["state"] != "acknowledged" {
			e = connectionFailure("reading_bookmark_result_unknown")
		}
		if e != nil {
			if bookmarkClientError(e) {
				if clearError := clear(text(command["operationId"])); clearError != nil {
					return nil, clearError
				}
				if runtimeErrorCode(e) == "reading_bookmark_changed" {
					state, readError := current()
					return map[string]any{"state": "changed", "bookmark": state}, readError
				}
			}
			return nil, e
		}
		if e = clear(text(command["operationId"])); e != nil {
			return nil, e
		}
		state, e := current()
		if e != nil {
			return nil, e
		}
		return map[string]any{"state": "acknowledged", "bookmark": state, "reconciled": !alreadySent}, nil
	}
	pending, e := l.read(ctx, key)
	if e != nil {
		return nil, e
	}
	if pending != nil {
		result, e := finish(pending, false)
		if e != nil {
			return nil, e
		}
		if uploadObject(pending["command"])["saved"] == selected["saved"] || result["state"] == "changed" {
			return result, nil
		}
	}
	state, e := current()
	if e != nil {
		return nil, e
	}
	if state["saved"] == selected["saved"] {
		return map[string]any{"state": "acknowledged", "bookmark": state}, nil
	}
	command := map[string]any{"operationId": uuid.NewString(), "reference": selected["reference"], "saved": selected["saved"], "expectedRevision": state["revision"]}
	ordered, _, e := bookmarkCommand(command)
	if e != nil {
		return nil, e
	}
	raw, e := protocol.EncodeJS(ordered)
	if e != nil {
		return nil, e
	}
	candidate := map[string]any{"command": ordered, "payloadHash": identity.Digest(raw)}
	var stored map[string]any
	e = l.update(ctx, key, func(prior map[string]any) (map[string]any, error) {
		if prior == nil {
			stored = map[string]any{"command": command, "payloadHash": candidate["payloadHash"]}
			return candidate, nil
		}
		stored = prior
		return prior, nil
	})
	if e != nil {
		return nil, e
	}
	same := text(uploadObject(stored["command"])["operationId"]) == text(command["operationId"])
	result, e := finish(stored, same)
	if e != nil {
		return nil, e
	}
	if !same && uploadObject(stored["command"])["saved"] != selected["saved"] {
		return nil, connectionFailure("reading_bookmark_changed")
	}
	return result, nil
}
func registerNativeBookmarkTool(server *mcp.Server, tools *toolRuntime, r *Runtime) {
	setter := NewNativeBookmarkSetter(r)
	addNativeTool(server, &mcp.Tool{Name: "galaxy_bookmark_set", Description: "Save or remove a private bookmark for the user’s selected post, exact method version, project or person. Handles revisions, stable operation IDs and lost responses automatically. This does not follow updates, infer interests, create work or extend source permission.", InputSchema: bookmarkContracts()["input"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}}, "native_bookmark_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		input, e := connectionObject(req.Params.Arguments)
		if e != nil {
			return toolError(e)
		}
		out, e := setter.Change(ctx, input)
		if e != nil {
			return toolError(e)
		}
		return toolResult(out)
	})
}
