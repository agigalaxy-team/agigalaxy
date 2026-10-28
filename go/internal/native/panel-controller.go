package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"math"
	"regexp"
	"sync"
)

type panelMap = map[string]any
type panelView struct {
	id, owner, endpoint, draftKey string
	input                         panelMap
	navigations                   map[string]bool
}
type panelLock struct {
	gate  chan struct{}
	users int
}
type NativePanel struct {
	Runtime    *Runtime
	Help       *NativeHelp
	Navigation *NativeNavigation
	mu         sync.Mutex
	closed     bool
	views      map[string]*panelView
	order      []string
	locks      map[string]*panelLock
}
type panelLease struct {
	panel                *NativePanel
	scope                ChoiceScope
	generation           uint64
	connection           connectionLease
	binding              string
	connectionGeneration any
}

func NewNativePanel(runtime *Runtime, help *NativeHelp, navigation *NativeNavigation) *NativePanel {
	return &NativePanel{Runtime: runtime, Help: help, Navigation: navigation, views: map[string]*panelView{}, locks: map[string]*panelLock{}}
}
func (p *NativePanel) Close() {
	p.mu.Lock()
	p.closed = true
	p.views = map[string]*panelView{}
	p.order = nil
	p.mu.Unlock()
}
func panelError(code string) error { return connectionFailure(code) }

var panelSafeCode = regexp.MustCompile(`^[a-z0-9_-]{1,100}$`)

func panelCode(e error) string {
	code := fault.Code(e)
	if code == "internal_error" && e != nil && e.Error() != "internal_error" {
		code = e.Error()
	}
	if panelSafeCode.MatchString(code) {
		return code
	}
	return "panel_source_unavailable"
}
func panelInteger(v any, min int64) bool {
	var f float64
	switch n := v.(type) {
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	case float64:
		f = n
	case json.Number:
		var e error
		f, e = n.Float64()
		if e != nil {
			return false
		}
	default:
		return false
	}
	return !math.IsNaN(f) && !math.IsInf(f, 0) && math.Trunc(f) == f && f >= float64(min) && f <= 9007199254740991
}
func panelFatal(e error) bool {
	return isOne(panelCode(e), "panel_identity_changed", "panel_connection_changed", "receipt_status_authority_changed")
}
func panelTextValue(value any, max int) any {
	var units jstext.String
	switch v := value.(type) {
	case string:
		units = jstext.From(v)
	case jstext.String:
		units = v
	default:
		return nil
	}
	if len(units) > max {
		units = units[:max]
	}
	if units.HasUnpaired() {
		return units
	}
	return units.Decoded()
}
func panelNonempty(value any) bool {
	switch v := value.(type) {
	case string:
		return v != ""
	case jstext.String:
		return len(v) > 0
	}
	return false
}
func panelContracts() panelMap {
	var out panelMap
	_ = protocol.Decode([]byte(nativePanelContractsJSON), &out)
	// Each original host-view union branch is an object. State that redundant
	// root constraint for MCP SDK registration without changing its branches.
	psObject(out["galaxy_host_view_state"])["type"] = "object"
	return out
}
func panelInput(name string, input any) (panelMap, error) {
	values, e := trustJSON(input)
	if e != nil {
		return nil, panelError("panel_operation_failed")
	}
	schema := psObject(panelContracts()[name])
	if schema == nil {
		return nil, panelError("panel_operation_failed")
	}
	if name == "galaxy_panel_message_send" {
		values["text"] = helpTrim(values["text"])
	}
	if name == "galaxy_host_view_state" {
		values["hostName"] = helpTrim(values["hostName"])
	}
	if name == "galaxy_panel" {
		if object := psObject(values["object"]); object != nil && object["query"] != nil {
			object["query"] = helpTrim(object["query"])
		}
	}
	remoteDefaults(schema, values)
	if remoteChatValidate(schema, values) != nil {
		return nil, panelError("panel_operation_failed")
	}
	return values, nil
}
func (p *NativePanel) begin(ctx context.Context) (context.Context, func(), *panelLease, error) {
	if p == nil || p.Runtime == nil {
		return nil, nil, nil, panelError("panel_closed")
	}
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return nil, nil, nil, panelError("panel_closed")
	}
	operation, cancel, generation, e := p.Runtime.operation(ctx, false)
	if e != nil {
		return nil, nil, nil, e
	}
	scope, e := p.Runtime.store.ChoiceScope(operation)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	connection, e := p.Runtime.connection.lease(operation, false)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	snapshot, e := p.Runtime.connection.Snapshot(operation)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	l := &panelLease{panel: p, scope: scope, generation: generation, connection: connection}
	if snapshot != nil {
		l.binding = snapshot.BindingID
		l.connectionGeneration = snapshot.Generation
	}
	if e = l.check(operation); e != nil {
		cancel()
		return nil, nil, nil, e
	}
	return operation, cancel, l, nil
}
func (l *panelLease) check(ctx context.Context) error {
	p := l.panel
	p.mu.Lock()
	closed := p.closed
	p.mu.Unlock()
	if closed {
		return panelError("panel_closed")
	}
	if e := ctx.Err(); e != nil {
		return e
	}
	if e := p.Runtime.checkOperation(l.generation); e != nil {
		return panelError("panel_connection_changed")
	}
	scope, e := p.Runtime.store.ChoiceScope(ctx)
	if e != nil {
		return e
	}
	if scope.Owner != l.scope.Owner || scope.Endpoint != l.scope.Endpoint {
		return panelError("panel_identity_changed")
	}
	if scope != l.scope {
		return panelError("panel_connection_changed")
	}
	if e = p.Runtime.connection.check(ctx, l.connection); e != nil {
		return panelError("panel_connection_changed")
	}
	return nil
}
func (l *panelLease) guard(dir string) error {
	if e := l.panel.Runtime.checkOperation(l.generation); e != nil {
		return panelError("panel_connection_changed")
	}
	if e := l.panel.Runtime.store.verifyChoiceWithin(dir, &l.scope); e != nil {
		return panelError("panel_identity_changed")
	}
	return nil
}
func (l *panelLease) required(ctx context.Context, id string) (*panelView, error) {
	p := l.panel
	p.mu.Lock()
	view := p.views[id]
	p.mu.Unlock()
	if view == nil {
		return nil, panelError("panel_view_expired")
	}
	if view.owner != l.scope.Owner || view.endpoint != l.scope.Endpoint {
		return nil, panelError("panel_identity_changed")
	}
	return view, l.check(ctx)
}
func (p *NativePanel) viewInput(v *panelView) panelMap {
	p.mu.Lock()
	defer p.mu.Unlock()
	return psObject(psClone(v.input))
}
func (l *panelLease) ownerScope() string {
	return helpHash([]any{nullableText(l.scope.Owner), nullableText(l.scope.DeviceID), l.scope.Endpoint, nullableText(l.binding), l.connectionGeneration})
}
func (l *panelLease) call(ctx context.Context, path string, input any) (panelMap, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	method := "POST"
	if input == nil {
		method = "GET"
	}
	out, e := l.panel.Runtime.Call(ctx, path, input, ConnectionCallOptions{Method: method, ExpectedScope: &l.scope})
	if check := l.check(ctx); check != nil {
		return nil, check
	}
	return out, e
}
func (l *panelLease) read(ctx context.Context, key string) (panelMap, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var value panelMap
	e := l.panel.Runtime.store.With(ctx, false, func(dir string) error {
		if e := l.guard(dir); e != nil {
			return e
		}
		var err error
		value, _, err = helpReadRecord(connectionRecordPath(dir, key))
		return err
	})
	if e != nil {
		return nil, e
	}
	return value, l.check(ctx)
}
func (l *panelLease) update(ctx context.Context, key string, change func(panelMap) (panelMap, error)) (panelMap, error) {
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	var next panelMap
	e := l.panel.Runtime.store.With(ctx, true, func(dir string) error {
		if e := l.guard(dir); e != nil {
			return e
		}
		old, _, e := helpReadRecord(connectionRecordPath(dir, key))
		if e != nil {
			return e
		}
		next, e = change(old)
		if e != nil {
			return e
		}
		return uploadNativeRecordWithin(dir, key, next)
	})
	if e != nil {
		return nil, e
	}
	return next, l.check(ctx)
}
func (l *panelLease) put(ctx context.Context, key string, value panelMap) error {
	_, e := l.update(ctx, key, func(panelMap) (panelMap, error) { return value, nil })
	return e
}
func (p *NativePanel) serial(ctx context.Context, key string, run func() (panelMap, error)) (panelMap, error) {
	p.mu.Lock()
	lock := p.locks[key]
	if lock == nil {
		lock = &panelLock{gate: make(chan struct{}, 1)}
		p.locks[key] = lock
	}
	lock.users++
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		lock.users--
		if lock.users == 0 {
			delete(p.locks, key)
		}
		p.mu.Unlock()
	}()
	select {
	case lock.gate <- struct{}{}:
		defer func() { <-lock.gate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return run()
}
func panelOrderedInput(input panelMap) []any {
	object := psObject(input["object"])
	var value any
	if object != nil {
		value = helpOrdered(object, "kind", "id", "versionId", "topic", "query", "section")
	}
	var origin any
	if o := psObject(input["origin"]); o != nil {
		origin = helpOrdered(o, "host", "workRef")
	}
	return []any{value, input["helpSessionId"], origin}
}
func (l *panelLease) helpCall(ctx context.Context, name string, input panelMap) (panelMap, error) {
	if l.panel.Help == nil {
		return nil, panelError("help_operation_failed")
	}
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	out, e := l.panel.Help.Call(ctx, name, input)
	if check := l.check(ctx); check != nil {
		return nil, check
	}
	return psObject(out), e
}

// Call handles the original non-reviewed panel operations. Execute is handled
// by the same toolRuntime choice review in panel-tools.go.
func (p *NativePanel) Call(ctx context.Context, name string, input any) (panelMap, error) {
	x, e := panelInput(name, input)
	if e != nil {
		return nil, e
	}
	operation, cancel, l, e := p.begin(ctx)
	if e != nil {
		if name == "galaxy_host_view_state" && panelCode(e) == "panel_closed" {
			return nil, panelError("host_view_closed")
		}
		return nil, e
	}
	defer cancel()
	ctx = operation
	if name == "galaxy_host_view_state" {
		out, e := l.hostView(ctx, x)
		if e != nil {
			switch panelCode(e) {
			case "panel_closed":
				e = panelError("host_view_closed")
			case "panel_identity_changed", "panel_connection_changed":
				e = panelError("receipt_status_authority_changed")
			}
		}
		return out, e
	}
	if name == "galaxy_panel" {
		id := uuid.NewString()
		parts := panelOrderedInput(x)
		key := helpHash([]any{l.scope.Endpoint, nullableText(l.scope.Owner), parts[0], parts[1], parts[2]})
		v := &panelView{id: id, owner: l.scope.Owner, endpoint: l.scope.Endpoint, input: x, draftKey: "compact-draft:" + key, navigations: map[string]bool{}}
		p.mu.Lock()
		if len(p.views) >= 64 {
			delete(p.views, p.order[0])
			p.order = p.order[1:]
		}
		p.views[id] = v
		p.order = append(p.order, id)
		p.mu.Unlock()
		return l.render(ctx, v)
	}
	v, e := l.required(ctx, text(x["viewId"]))
	if e != nil {
		return nil, e
	}
	switch name {
	case "galaxy_panel_refresh":
		return l.render(ctx, v)
	case "galaxy_panel_draft_save", "galaxy_panel_reply_draft_save":
		return l.save(ctx, v, x, name == "galaxy_panel_reply_draft_save")
	case "galaxy_panel_message_send":
		return l.sendMessage(ctx, v, x)
	case "galaxy_panel_open":
		if p.Navigation == nil {
			return nil, panelError("panel_object_required")
		}
		object := psObject(p.viewInput(v)["object"])
		if x["entry"] != nil {
			object = panelMap{"kind": x["entry"]}
		}
		if object == nil {
			object = panelMap{"kind": "search"}
		}
		query := panelMap{"object": object}
		if origin := p.viewInput(v)["origin"]; origin != nil {
			query["origin"] = origin
		}
		out, e := p.Navigation.Open(ctx, query)
		if check := l.check(ctx); check != nil {
			return nil, check
		}
		if e != nil {
			return nil, e
		}
		if id := text(out["navigationId"]); id != "" {
			p.mu.Lock()
			v.navigations[id] = true
			p.mu.Unlock()
		}
		out["viewId"], out["businessMutation"] = v.id, false
		return out, nil
	case "galaxy_panel_return":
		p.mu.Lock()
		known := v.navigations[text(x["navigationId"])]
		p.mu.Unlock()
		if !known {
			return nil, panelError("panel_navigation_mismatch")
		}
		if _, e = p.Navigation.Resume(ctx, text(x["navigationId"])); e != nil {
			return nil, e
		}
		if e = l.check(ctx); e != nil {
			return nil, e
		}
		out, e := l.render(ctx, v)
		if e == nil {
			out["returned"], out["navigationId"] = true, x["navigationId"]
		}
		return out, e
	case "galaxy_panel_select", "galaxy_panel_finish", "galaxy_panel_action_prepare", "galaxy_panel_action_preview", "galaxy_panel_action_reconcile":
		return l.helpOperation(ctx, v, name, x)
	}
	return nil, panelError("panel_operation_failed")
}

func (l *panelLease) save(ctx context.Context, v *panelView, x panelMap, reply bool) (panelMap, error) {
	key := v.draftKey
	field := "draft"
	if reply {
		if psObject(l.panel.viewInput(v)["object"])["kind"] != "room" {
			return nil, panelError("panel_room_required")
		}
		key += ":reply"
		field = "replyDraft"
	}
	return l.panel.serial(ctx, key, func() (panelMap, error) {
		row, e := l.update(ctx, key, func(old panelMap) (panelMap, error) {
			if old["revision"] != nil && !panelInteger(old["revision"], 0) || psInt(old["revision"]) != psInt(x["expectedRevision"]) {
				return nil, panelError("panel_draft_conflict")
			}
			return panelMap{"draft": x["draft"], "revision": psInt(x["expectedRevision"]) + 1, "updatedAt": l.panel.Runtime.connection.now().Unix()}, nil
		})
		if e != nil {
			return nil, e
		}
		return panelMap{"viewId": v.id, field: panelMap{"text": row["draft"], "revision": row["revision"], "scope": "this-device-only"}, "businessMutation": false}, nil
	})
}
func (l *panelLease) hostView(ctx context.Context, x panelMap) (panelMap, error) {
	if l.scope.Owner == "" || l.scope.Endpoint == "" || l.ownerScope() != x["ownerScope"] {
		return nil, panelError("host_view_owner_changed")
	}
	key := "host-view-state:" + helpHash([]any{l.scope.Owner, l.scope.Endpoint, x["hostName"]})
	var row panelMap
	var e error
	if x["action"] == "read" {
		row, e = l.read(ctx, key)
	} else {
		row, e = l.update(ctx, key, func(old panelMap) (panelMap, error) {
			if old["revision"] != nil && !panelInteger(old["revision"], 0) || psInt(old["revision"]) != psInt(x["expectedRevision"]) {
				return nil, panelError("host_view_revision_conflict")
			}
			var mode any
			if x["action"] == "save" {
				mode = x["mode"]
			}
			return panelMap{"schemaVersion": 1, "revision": psInt(x["expectedRevision"]) + 1, "mode": mode}, nil
		})
	}
	if e != nil {
		return nil, e
	}
	if row != nil && (!panelInteger(row["schemaVersion"], 1) || psInt(row["schemaVersion"]) != 1 || !panelInteger(row["revision"], 1) || row["mode"] != nil && !isOne(text(row["mode"]), "inline", "fullscreen", "pip")) {
		return nil, panelError("host_view_record_invalid")
	}
	return panelMap{"kind": "galaxy-host-view-state", "ownerScope": x["ownerScope"], "hostName": x["hostName"], "revision": psInt(row["revision"]), "mode": row["mode"], "scope": "this-device-only", "businessMutation": false}, nil
}
