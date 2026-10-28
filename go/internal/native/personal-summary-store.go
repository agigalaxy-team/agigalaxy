package native

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/summaries"
	"os"
	"regexp"
	"sort"
	"sync"
)

type NativePersonalSummaries struct {
	runtime *Runtime
	mu      sync.Mutex
	closed  bool
	syncMu  sync.Mutex
}

func NewNativePersonalSummaries(r *Runtime) *NativePersonalSummaries {
	return &NativePersonalSummaries{runtime: r}
}
func (h *NativePersonalSummaries) Close() { h.mu.Lock(); h.closed = true; h.mu.Unlock() }

type personalSummaryLease struct {
	host       *NativePersonalSummaries
	scope      ChoiceScope
	generation uint64
	connection *ConnectionSnapshot
	order      []string
}

func psInt(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		f, _ := n.Float64()
		return int64(f)
	}
	return 0
}
func psClone(v any) any {
	raw, e := jstext.EncodeJSON(v)
	if e != nil {
		return nil
	}
	out, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil
	}
	return out
}
func psObject(v any) map[string]any { return uploadObject(v) }
func psEqual(a, b any) bool {
	x, e := jstext.EncodeJSON(a)
	if e != nil {
		return false
	}
	y, e := jstext.EncodeJSON(b)
	return e == nil && string(x) == string(y)
}
func psContracts() map[string]any {
	var out map[string]any
	_ = protocol.Decode([]byte(personalSummaryContractsJSON), &out)
	return out
}
func psInitial(owner string) map[string]any {
	return map[string]any{"schemaVersion": 1, "subjectId": owner, "preference": map[string]any{"state": "unset", "endpoint": nil, "roomIds": nil, "includeExisting": true, "selectedAt": nil, "cloudRevision": nil}, "summaries": map[string]any{}, "queue": []any{}}
}
func psState(v any, owner string) (map[string]any, error) {
	if v == nil {
		return psInitial(owner), nil
	}
	s := psObject(v)
	if s == nil || s["subjectId"] != owner || psInt(s["schemaVersion"]) != 1 || psObject(s["preference"]) == nil || psObject(s["summaries"]) == nil {
		return nil, connectionFailure("invalid_summary_local_owner")
	}
	if _, ok := s["queue"].([]any); !ok {
		return nil, connectionFailure("invalid_summary_local_owner")
	}
	return s, nil
}
func (h *NativePersonalSummaries) begin(ctx context.Context) (context.Context, func(), *personalSummaryLease, error) {
	h.mu.Lock()
	closed := h.closed
	h.mu.Unlock()
	if closed {
		return nil, nil, nil, connectionFailure("native_runtime_closed")
	}
	op, cancel, generation, e := h.runtime.operation(ctx, false)
	if e != nil {
		return nil, nil, nil, e
	}
	scope, e := h.runtime.store.ChoiceScope(op)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	if scope.Owner == "" {
		cancel()
		return nil, nil, nil, connectionFailure("native_identity_required")
	}
	snapshot, e := h.runtime.connection.Snapshot(op)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	if snapshot != nil && snapshot.SubjectID != scope.Owner {
		snapshot = nil
	}
	return op, cancel, &personalSummaryLease{host: h, scope: scope, generation: generation, connection: snapshot}, nil
}
func (l *personalSummaryLease) check(ctx context.Context, network bool) error {
	if e := ctx.Err(); e != nil {
		return e
	}
	l.host.mu.Lock()
	closed := l.host.closed
	l.host.mu.Unlock()
	if closed {
		return connectionFailure("native_runtime_closed")
	}
	if e := l.host.runtime.checkOperation(l.generation); e != nil {
		return e
	}
	current, e := l.host.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return e
	}
	if current != l.scope {
		return connectionFailure("native_identity_changed")
	}
	if network {
		now, e := l.host.runtime.connection.Snapshot(ctx)
		if e != nil {
			return e
		}
		before := l.connection
		if before == nil || now == nil || now.SubjectID != l.scope.Owner || before.Endpoint != now.Endpoint || before.BindingID != now.BindingID || before.Generation != now.Generation {
			return connectionFailure("summary_binding_changed")
		}
	}
	return nil
}
func (l *personalSummaryLease) read(ctx context.Context) (map[string]any, error) {
	if e := l.check(ctx, false); e != nil {
		return nil, e
	}
	var out map[string]any
	e := l.host.runtime.store.With(ctx, false, func(dir string) error {
		if e := l.host.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		raw, e := os.ReadFile(connectionRecordPath(dir, "personal-summary:"+l.scope.Owner))
		if errors.Is(e, os.ErrNotExist) {
			out = psInitial(l.scope.Owner)
			return nil
		}
		if e != nil {
			return e
		}
		if len(raw) > 8<<20 {
			return connectionFailure("native_record_invalid")
		}
		l.order = psRecordOrder(raw)
		v, e := jstext.DecodeJSON(raw)
		if e != nil {
			return e
		}
		out, e = psState(v, l.scope.Owner)
		return e
	})
	if e != nil {
		return nil, e
	}
	return out, l.check(ctx, false)
}
func (l *personalSummaryLease) update(ctx context.Context, change func(map[string]any) error) (map[string]any, error) {
	if e := l.check(ctx, false); e != nil {
		return nil, e
	}
	var out map[string]any
	e := l.host.runtime.store.With(ctx, true, func(dir string) error {
		if e := l.host.runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
			return e
		}
		path := connectionRecordPath(dir, "personal-summary:"+l.scope.Owner)
		raw, e := os.ReadFile(path)
		var value any
		if e == nil {
			if len(raw) > 8<<20 {
				return connectionFailure("native_record_invalid")
			}
			l.order = psRecordOrder(raw)
			value, e = jstext.DecodeJSON(raw)
		} else if errors.Is(e, os.ErrNotExist) {
			e = nil
		}
		if e != nil {
			return e
		}
		out, e = psState(value, l.scope.Owner)
		if e != nil {
			return e
		}
		if e = change(out); e != nil {
			return e
		}
		view := map[string]any{}
		for k, v := range out {
			view[k] = v
		}
		records := psObject(out["summaries"])
		ordered := protocol.NewOrderedObject()
		for _, id := range l.order {
			if r, ok := records[id]; ok {
				ordered.Set(id, r)
			}
		}
		remaining := []string{}
		for id := range records {
			if _, ok := ordered.Values()[id]; !ok {
				remaining = append(remaining, id)
			}
		}
		sort.Strings(remaining)
		for _, id := range remaining {
			ordered.Set(id, records[id])
		}
		view["summaries"] = ordered
		l.order = ordered.Keys()
		return uploadNativeRecordWithin(dir, "personal-summary:"+l.scope.Owner, view)
	})
	if e != nil {
		return nil, e
	}
	return out, l.check(ctx, false)
}
func (l *personalSummaryLease) call(ctx context.Context, action string, input any) (map[string]any, error) {
	if e := l.check(ctx, true); e != nil {
		return nil, e
	}
	out, e := l.host.runtime.Call(ctx, "/v2/personal-summaries/"+action, input, ConnectionCallOptions{ExpectedScope: &l.scope})
	if check := l.check(ctx, true); check != nil {
		return nil, check
	}
	if e != nil {
		return nil, e
	}
	raw, e := jstext.EncodeJSON(out)
	if e != nil {
		return nil, e
	}
	v, e := jstext.DecodeJSON(raw)
	return psObject(v), e
}
func psAllowed(p, r map[string]any) bool {
	if !isOne(text(p["state"]), "enabled", "enabled-pending-binding") || r["endpoint"] != p["endpoint"] {
		return false
	}
	if p["roomIds"] != nil {
		found := false
		for _, v := range uploadRows(p["roomIds"]) {
			found = found || v == r["roomId"]
		}
		if !found {
			return false
		}
	}
	return p["includeExisting"] == true || psFloat(r["createdAt"]) >= psFloat(p["selectedAt"])
}
func psQueueFind(s map[string]any, id string) map[string]any {
	for _, v := range uploadRows(s["queue"]) {
		if q := psObject(v); q["versionId"] == id {
			return q
		}
	}
	return nil
}
func psSummaryRecords(s map[string]any, order []string) []map[string]any {
	records := psObject(s["summaries"])
	out := []map[string]any{}
	seen := map[string]bool{}
	for _, id := range order {
		if v, ok := records[id]; ok {
			out = append(out, psObject(v))
			seen[id] = true
		}
	}
	remaining := []string{}
	for id := range records {
		if !seen[id] {
			remaining = append(remaining, id)
		}
	}
	sort.Strings(remaining)
	for _, id := range remaining {
		out = append(out, psObject(records[id]))
	}
	return out
}
func psRecordOrder(raw []byte) []string {
	value, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil
	}
	outer, ok := value.(*protocol.OrderedObject)
	if !ok {
		return nil
	}
	records, ok := outer.Values()["summaries"].(*protocol.OrderedObject)
	if !ok {
		return nil
	}
	return records.Keys()
}
func psFilterQueue(s map[string]any, keep func(map[string]any) bool) {
	out := []any{}
	for _, v := range uploadRows(s["queue"]) {
		q := psObject(v)
		if keep(q) {
			out = append(out, q)
		}
	}
	s["queue"] = out
}
func psContent(v any) (map[string]any, error) {
	raw, e := jstext.EncodeJSON(v)
	if e != nil {
		return nil, e
	}
	parsed, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, e
	}
	id := "00000000-0000-0000-0000-000000000000"
	out, e := summaries.Parse("put", map[string]any{"versionId": id, "summaryId": id, "roomId": id, "baseRevision": 0, "preferenceRevision": 0, "content": parsed})
	if e != nil {
		return nil, e
	}
	return psObject(out["content"]), nil
}

func psFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	case int64:
		return float64(n)
	case int:
		return float64(n)
	}
	return 0
}

var personalSummaryErrorCode = regexp.MustCompile(`^[a-z0-9_]{1,80}$`)
