package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type NativeHelp struct {
	runtime *Runtime
	mu      sync.Mutex
	closed  bool
}
type helpLease struct {
	host       *NativeHelp
	scope      ChoiceScope
	generation uint64
}

func NewNativeHelp(runtime *Runtime) *NativeHelp { return &NativeHelp{runtime: runtime} }
func (h *NativeHelp) Close()                     { h.mu.Lock(); h.closed = true; h.mu.Unlock() }
func (h *NativeHelp) now() int64                 { return h.runtime.connection.now().Unix() }
func helpError(code string) error                { return connectionFailure(code) }
func helpContracts() map[string]any              { return remoteSelectedContracts(nativeHelpContractsJSON) }
func helpSchema(name string) map[string]any {
	return psObject(psObject(helpContracts()["schemas"])[name])
}
func helpValidate(name string, value map[string]any) error {
	schema := helpSchema(name)
	remoteDefaults(schema, value)
	if remoteChatValidate(schema, value) != nil {
		return helpError("help_operation_failed")
	}
	return nil
}
func helpStrings(v any) []string {
	out := []string{}
	for _, v := range trustArray(v) {
		out = append(out, text(v))
	}
	return out
}
func helpHas(v any, key string) bool {
	for _, s := range helpStrings(v) {
		if s == key {
			return true
		}
	}
	return false
}
func helpPending(v any) bool { return isOne(text(v), "submitting", "unknown", "conflict") }
func helpReadRecord(path string) (map[string]any, bool, error) {
	var raw json.RawMessage
	ok, e := readJSON(path, &raw)
	if e != nil || !ok {
		return nil, ok, e
	}
	value, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, ok, e
	}
	if value == nil {
		return nil, ok, nil
	}
	row, valid := value.(map[string]any)
	if !valid {
		return nil, ok, helpError("help_operation_failed")
	}
	return row, ok, nil
}
func (h *NativeHelp) begin(ctx context.Context) (*helpLease, error) {
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
		return nil, helpError("help_identity_changed")
	}
	l := &helpLease{h, scope, generation}
	return l, l.check(op)
}
func (l *helpLease) check(ctx context.Context) error {
	l.host.mu.Lock()
	closed := l.host.closed
	l.host.mu.Unlock()
	if closed {
		return helpError("help_identity_changed")
	}
	if e := ctx.Err(); e != nil {
		return e
	}
	if e := l.host.runtime.checkOperation(l.generation); e != nil {
		return helpError("help_identity_changed")
	}
	scope, e := l.host.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return e
	}
	if scope != l.scope {
		return helpError("help_identity_changed")
	}
	return nil
}
func (l *helpLease) guard(dir string) error {
	r := l.host.runtime
	if e := r.store.verifyChoiceWithin(dir, &l.scope); e != nil {
		return helpError("help_identity_changed")
	}
	for _, name := range []string{".galaxy-initialization.json", ".galaxy-reset.json"} {
		var row any
		if _, e := readJSON(filepath.Join(dir, name), &row); e != nil {
			return e
		}
		if row != nil {
			return helpError("help_identity_changed")
		}
	}
	selected, e := r.connection.selectionWithin(dir)
	if e != nil {
		return e
	}
	var subject string
	var proof map[string]any
	if selected.Active != nil {
		subject = selected.Active.SubjectID
		proof = selected.Active.GenesisProof
	} else {
		var local map[string]any
		if e := readFallback(dir, "galaxy-id.json", "node.json", &local); e != nil {
			return e
		}
		subject = text(local["id"])
		proof = psObject(local["genesisProof"])
	}
	raw, e := protocol.Encode(proof)
	if e != nil || subject != l.scope.Owner || !identity.VerifyPortableGenesis(subject, raw) {
		return helpError("help_identity_changed")
	}
	return nil
}
func (l *helpLease) folder(dir string) string {
	raw, _ := protocol.EncodeJS([]any{l.scope.Endpoint, l.scope.Owner})
	return filepath.Join(dir, "help-v2", identity.Digest(raw))
}
func (l *helpLease) path(dir, id, operation string) (string, error) {
	if !controlUUID(id) || operation != "" && !controlUUID(operation) {
		return "", helpError("help_operation_failed")
	}
	name := id
	if operation != "" {
		name += "-action-" + operation
	}
	return filepath.Join(l.folder(dir), name+".json"), nil
}
func (l *helpLease) load(dir, id string) (map[string]any, error) {
	if e := l.guard(dir); e != nil {
		return nil, e
	}
	path, e := l.path(dir, id, "")
	if e != nil {
		return nil, e
	}
	row, ok, e := helpReadRecord(path)
	if e != nil {
		return nil, e
	}
	if !ok || row == nil {
		return nil, helpError("help_session_not_found")
	}
	if e = helpValidate("session", row); e != nil {
		return nil, e
	}
	if row["id"] != id || row["endpoint"] != l.scope.Endpoint || row["subjectId"] != l.scope.Owner {
		return nil, helpError("help_scope_mismatch")
	}
	return row, nil
}
func (l *helpLease) get(ctx context.Context, id string) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var out map[string]any
	e := l.host.runtime.store.With(ctx, false, func(dir string) error { var e error; out, e = l.load(dir, id); return e })
	if e != nil {
		return nil, e
	}
	return out, l.check(ctx)
}
func (l *helpLease) create(ctx context.Context, input map[string]any) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	at := l.host.now()
	row := map[string]any{"schemaVersion": 2, "id": uuid.NewString(), "revision": 1, "endpoint": l.scope.Endpoint, "subjectId": l.scope.Owner, "localTaskRef": input["localTaskRef"], "caseId": input["caseId"], "taskId": input["taskId"], "createdAt": at, "updatedAt": at, "pauseState": "active", "basis": []any{}, "offers": []any{}, "selectedHelpIds": []any{}, "queries": []any{}, "linkedOperations": []any{}, "actionOperations": []any{}, "selectionEffect": "local-choice-only", "cloudSync": "off"}
	if e := helpValidate("session", row); e != nil {
		return nil, e
	}
	e := l.host.runtime.store.With(ctx, true, func(dir string) error {
		if e := l.guard(dir); e != nil {
			return e
		}
		path, e := l.path(dir, text(row["id"]), "")
		if e != nil {
			return e
		}
		if e = os.MkdirAll(l.folder(dir), 0700); e != nil {
			return e
		}
		return writeJSON(path, row)
	})
	if e != nil {
		return nil, e
	}
	return row, l.check(ctx)
}
func (l *helpLease) update(ctx context.Context, id string, revision any, change func(map[string]any) error) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var row map[string]any
	e := l.host.runtime.store.With(ctx, true, func(dir string) error {
		var e error
		row, e = l.load(dir, id)
		if e != nil {
			return e
		}
		if revision != nil && psInt(revision) != psInt(row["revision"]) {
			return helpError("help_session_changed")
		}
		original := map[string]any{}
		for _, k := range []string{"id", "endpoint", "subjectId", "localTaskRef", "createdAt"} {
			original[k] = row[k]
		}
		version := psInt(row["revision"])
		if e = change(row); e != nil {
			return e
		}
		for k, v := range original {
			row[k] = v
		}
		row["revision"] = version + 1
		row["updatedAt"] = l.host.now()
		if e = helpValidate("session", row); e != nil {
			return e
		}
		raw, e := jstext.EncodeJSON(row)
		if e != nil {
			return e
		}
		if len(raw) > 524288 {
			return helpError("help_local_storage_full")
		}
		path, _ := l.path(dir, id, "")
		return writeJSON(path, row)
	})
	if e != nil {
		return nil, e
	}
	return row, l.check(ctx)
}
func (l *helpLease) operation(ctx context.Context, id, operation string, change func(map[string]any) (map[string]any, error)) (map[string]any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var row map[string]any
	e := l.host.runtime.store.With(ctx, change != nil, func(dir string) error {
		if _, e := l.load(dir, id); e != nil {
			return e
		}
		path, e := l.path(dir, id, operation)
		if e != nil {
			return e
		}
		if row, _, e = helpReadRecord(path); e != nil {
			return e
		}
		if change != nil {
			row, e = change(row)
			if e != nil {
				return e
			}
		}
		if row != nil && (row["sessionId"] != id || row["operationId"] != operation || row["subjectId"] != l.scope.Owner || row["endpoint"] != l.scope.Endpoint) {
			return helpError("help_scope_mismatch")
		}
		if change == nil {
			return nil
		}
		raw, e := jstext.EncodeJSON(row)
		if e != nil {
			return e
		}
		if row == nil || len(raw) > 100000 {
			return helpError("help_operation_invalid")
		}
		return writeJSON(path, row)
	})
	if e != nil {
		return nil, e
	}
	return row, l.check(ctx)
}
func (l *helpLease) forget(ctx context.Context, id string) (any, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	e := l.host.runtime.store.With(ctx, true, func(dir string) error {
		if _, e := l.load(dir, id); e != nil {
			return e
		}
		files, e := os.ReadDir(l.folder(dir))
		if e != nil {
			return e
		}
		prefix := id + "-action-"
		for _, file := range files {
			name := file.Name()
			if strings.HasPrefix(name, prefix) && strings.HasSuffix(name, ".json") && controlUUID(strings.TrimSuffix(strings.TrimPrefix(name, prefix), ".json")) {
				if e = os.Remove(filepath.Join(l.folder(dir), name)); e != nil {
					return e
				}
			}
		}
		path, _ := l.path(dir, id, "")
		return os.Remove(path)
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"id": id, "deleted": true, "localOnly": true, "remoteOperationsCanceled": false}, l.check(ctx)
}
func (l *helpLease) call(ctx context.Context, path string, input any) (map[string]any, any, error) {
	if e := l.check(ctx); e != nil {
		return nil, nil, e
	}
	var raw json.RawMessage
	method := "POST"
	if input == nil {
		method = "GET"
	}
	out, e := l.host.runtime.Call(ctx, path, input, ConnectionCallOptions{ExpectedScope: &l.scope, Method: method, ResponseJSON: &raw})
	if check := l.check(ctx); check != nil {
		return nil, nil, check
	}
	if e != nil {
		return nil, nil, e
	}
	ordered, e := protocol.DecodeOrdered(raw)
	return out, ordered, e
}
