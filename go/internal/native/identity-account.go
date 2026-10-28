package native

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"net/url"
	"sync"
)

type NativeIdentityAccounts struct {
	runtime    *Runtime
	mu         sync.Mutex
	previews   map[string]*nativeAccountPreview
	recovering map[string]*nativeAccountRecovery
}
type nativeAccountRecovery struct {
	done   chan struct{}
	result any
	err    error
}
type nativeAccountPreview struct {
	lease                      *nativeIdentityLease
	id, action, payload, state string
	target, content            map[string]any
	expiresAt                  int64
	receipt                    any
}
type NativeIdentityAccountRead struct {
	Action     string `json:"action"`
	ProviderID string `json:"providerId,omitempty"`
	ID         string `json:"id,omitempty"`
	After      string `json:"after,omitempty"`
	Limit      int    `json:"limit,omitempty"`
}

func NewNativeIdentityAccounts(runtime *Runtime) *NativeIdentityAccounts {
	return &NativeIdentityAccounts{runtime: runtime, previews: map[string]*nativeAccountPreview{}, recovering: map[string]*nativeAccountRecovery{}}
}
func (a *NativeIdentityAccounts) key(owner, id, action string) string {
	return "native-account-link:" + a.runtime.config.Endpoint + ":" + owner + ":" + id + ":" + action
}
func (a *NativeIdentityAccounts) index(owner string) string {
	return "native-account-link-index:" + a.runtime.config.Endpoint + ":" + owner
}
func (a *NativeIdentityAccounts) lease(ctx context.Context) (context.Context, func(), *nativeIdentityLease, error) {
	ctx, cancel, l, e := a.runtime.identityLease(ctx, true)
	if e != nil {
		return nil, nil, nil, e
	}
	snapshot, e := a.runtime.connection.Snapshot(ctx)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	if snapshot == nil || !connectionIncludes(snapshot.Scopes, "binding") {
		cancel()
		return nil, nil, nil, connectionFailure("native_account_current_binding_required")
	}
	return ctx, cancel, l, nil
}
func (a *NativeIdentityAccounts) read(ctx context.Context, l *nativeIdentityLease, x NativeIdentityAccountRead) (map[string]any, error) {
	if !isOne(x.Action, "providers", "begin", "status", "cancel", "query") || x.Action == "begin" && !nativeAccountProviderID(x.ProviderID) || isOne(x.Action, "status", "cancel") && !controlUUID(x.ID) || x.Action == "query" && (x.ID != "" && !controlUUID(x.ID) || x.After != "" && !controlUUID(x.After) || x.Limit < 0 || x.Limit > 100) {
		return nil, connectionFailure("native_account_link_input_invalid")
	}
	input := map[string]any{}
	switch x.Action {
	case "begin":
		input["providerId"] = x.ProviderID
	case "status", "cancel":
		input["id"] = x.ID
	case "query":
		if x.ID != "" {
			input["id"] = x.ID
		}
		if x.After != "" {
			input["after"] = x.After
		}
		limit := x.Limit
		if limit == 0 {
			limit = 20
		}
		input["limit"] = limit
	}
	value, e := l.call(ctx, "/v1/identity/"+x.Action, input, false)
	if e != nil {
		return nil, e
	}
	switch x.Action {
	case "providers":
		if !connectionExact(value, "endpoint", "providers", "galaxyAuthorization") || value["endpoint"] != l.scope.Endpoint || value["galaxyAuthorization"] != false {
			return nil, connectionFailure("native_account_link_provider_mismatch")
		}
		providers, ok := value["providers"].([]any)
		if !ok || len(providers) > 8 {
			return nil, connectionFailure("native_account_link_provider_mismatch")
		}
		for _, provider := range providers {
			if !nativeAccountProvider(uploadObject(provider), l.scope.Endpoint, false) {
				return nil, connectionFailure("native_account_link_provider_mismatch")
			}
		}
	case "begin":
		if !nativeAccountProvider(value, l.scope.Endpoint, true) || value["id"] != x.ProviderID || !controlUUID(value["loginId"]) || value["subjectId"] != l.scope.Owner || value["bindingId"] != l.connection.bindingID || value["endpoint"] != l.scope.Endpoint || value["galaxyAuthorization"] != false || !connectionSafeInteger(value["expiresAt"]) || integer(value["expiresAt"]) <= a.runtime.connection.now().Unix() || integer(value["expiresAt"]) > a.runtime.connection.now().Unix()+300 {
			return nil, connectionFailure("native_account_link_login_mismatch")
		}
		target, e := url.Parse(text(value["authorizationUrl"]))
		if e != nil || target.Scheme != "https" || target.Host == "" || target.User != nil || target.Fragment != "" {
			return nil, connectionFailure("native_account_link_login_mismatch")
		}
		q := target.Query()
		if q.Get("redirect_uri") != value["redirectUri"] || q.Get("client_id") != value["clientId"] || !isOne(q.Get("scope"), "openid", "openid email") || q.Get("response_type") != "code" || q.Get("code_challenge_method") != "S256" || q.Get("state") == "" || q.Get("nonce") == "" {
			return nil, connectionFailure("native_account_link_login_mismatch")
		}
	case "query":
		if e = nativeAccountPage(value, l); e != nil {
			return nil, e
		}
	default:
		if value["id"] != x.ID || !isOne(text(value["state"]), "preparing", "awaiting-login", "exchanging", "awaiting-local-signature", "linked", "revoked", "failed", "canceled") {
			return nil, connectionFailure("native_account_link_status_mismatch")
		}
	}
	return value, nil
}
func (a *NativeIdentityAccounts) Read(ctx context.Context, input NativeIdentityAccountRead) (any, error) {
	ctx, cancel, l, e := a.lease(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	return a.read(ctx, l, input)
}
func (a *NativeIdentityAccounts) Prepare(ctx context.Context, action, id string) (any, error) {
	if !isOne(action, "link", "unlink") || !controlUUID(id) {
		return nil, connectionFailure("native_account_link_input_invalid")
	}
	ctx, cancel, l, e := a.lease(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	now := a.runtime.connection.now().UnixMilli()
	a.mu.Lock()
	for id, p := range a.previews {
		if p.state == "prepared" && (p.expiresAt <= now || p.lease.scope != l.scope || p.lease.connection.bindingID != l.connection.bindingID) {
			delete(a.previews, id)
		}
	}
	if len(a.previews) >= 32 {
		a.mu.Unlock()
		return nil, connectionFailure("native_account_preview_limit")
	}
	a.mu.Unlock()
	var target map[string]any
	payload := ""
	if action == "link" {
		status, e := a.read(ctx, l, NativeIdentityAccountRead{Action: "status", ID: id})
		if e != nil {
			return nil, e
		}
		if !isOne(text(status["state"]), "awaiting-local-signature", "linked") {
			return nil, connectionFailure("native_account_login_required")
		}
		payload = text(status["payloadJson"])
		target, e = connectionObject([]byte(payload))
		if e != nil || !nativeAccountIntent(target, l, a.runtime.connection.now().Unix()) || target["id"] != id || !connectionEqual(status["intent"], target) {
			return nil, connectionFailure("native_account_link_preview_mismatch")
		}
	} else {
		page, e := a.read(ctx, l, NativeIdentityAccountRead{Action: "query", ID: id, Limit: 1})
		if e != nil {
			return nil, e
		}
		rows := uploadRows(page["items"])
		if len(rows) == 0 {
			return nil, connectionFailure("native_account_link_unavailable")
		}
		target = uploadObject(rows[0])
		if target["id"] != id || target["state"] == "revoked" {
			return nil, connectionFailure("native_account_link_unavailable")
		}
	}
	content := map[string]any{"action": action, "endpoint": l.scope.Endpoint, "subjectId": l.scope.Owner, "target": target, "galaxyAuthorization": false}
	expires := now + 300000
	if action == "link" {
		expires = min(expires, integer(target["expiresAt"])*1000)
	}
	previewID := uuid.NewString()
	a.mu.Lock()
	if len(a.previews) >= 32 {
		a.mu.Unlock()
		return nil, connectionFailure("native_account_preview_limit")
	}
	a.previews[previewID] = &nativeAccountPreview{l, id, action, payload, "prepared", target, content, expires, nil}
	a.mu.Unlock()
	return map[string]any{"previewId": previewID, "id": id, "action": action, "state": "prepared", "preview": identityClone(content), "expiresAt": expires, "remoteSubmitted": false}, nil
}
func (a *NativeIdentityAccounts) Preview(ctx context.Context, id string) (any, error) {
	a.mu.Lock()
	p := a.previews[id]
	if p == nil || p.expiresAt <= a.runtime.connection.now().UnixMilli() {
		a.mu.Unlock()
		return nil, connectionFailure("native_account_preview_unavailable")
	}
	content := identityClone(p.content)
	l := p.lease
	expires := p.expiresAt
	a.mu.Unlock()
	if e := l.check(ctx); e != nil {
		return nil, e
	}
	return map[string]any{"previewId": id, "preview": content, "expiresAt": expires}, nil
}
func (a *NativeIdentityAccounts) save(ctx context.Context, l *nativeIdentityLease, id, action string, request map[string]any) error {
	row := map[string]any{"id": id, "action": action, "subjectId": l.scope.Owner, "bindingId": l.connection.bindingID, "deviceId": l.scope.DeviceID, "endpoint": l.scope.Endpoint, "request": request, "state": "submitting", "createdAt": a.runtime.connection.now().Unix()}
	e := l.update(ctx, a.key(l.scope.Owner, id, action), func(prior map[string]any) (map[string]any, error) {
		if prior != nil {
			if !connectionEqual(prior["request"], request) || prior["bindingId"] != row["bindingId"] || prior["deviceId"] != row["deviceId"] {
				return nil, connectionFailure("native_account_original_operation_changed")
			}
			prior["state"] = "submitting"
			return prior, nil
		}
		return row, nil
	})
	if e != nil {
		return e
	}
	return l.updateAny(ctx, a.index(l.scope.Owner), func(prior any) (any, error) {
		items := []any{}
		for _, value := range uploadRows(prior) {
			r := uploadObject(value)
			if r["id"] != id || r["action"] != action {
				items = append(items, value)
			}
		}
		return append(items, map[string]any{"id": id, "action": action}), nil
	})
}
func nativeAccountOutcome(receipt map[string]any, id, action string) bool {
	state := "linked"
	if action == "unlink" {
		state = "revoked"
	}
	return receipt["id"] == id && receipt["state"] == state && receipt["galaxyAuthorization"] == false
}
func (a *NativeIdentityAccounts) send(ctx context.Context, l *nativeIdentityLease, id, action string, request map[string]any) (map[string]any, error) {
	if e := a.save(ctx, l, id, action, request); e != nil {
		return nil, e
	}
	route := "confirm"
	if action == "unlink" {
		route = "revoke"
	}
	receipt, e := l.call(ctx, "/v1/identity/"+route, request, false)
	if e == nil && !nativeAccountOutcome(receipt, id, action) {
		e = connectionFailure("native_account_original_result_changed")
	}
	if e != nil {
		var rejection *ConnectionHTTPError
		state := "unknown"
		if errors.As(e, &rejection) && rejection.Outcome == "rejected" {
			state = "rejected"
		}
		_ = l.update(ctx, a.key(l.scope.Owner, id, action), func(row map[string]any) (map[string]any, error) {
			if row == nil || !connectionEqual(row["request"], request) {
				return nil, connectionFailure("native_account_original_operation_changed")
			}
			row["state"], row["error"] = state, runtimeErrorCode(e)
			return row, nil
		})
		return nil, e
	}
	e = l.update(ctx, a.key(l.scope.Owner, id, action), func(row map[string]any) (map[string]any, error) {
		if row == nil || !connectionEqual(row["request"], request) {
			return nil, connectionFailure("native_account_original_operation_changed")
		}
		row["state"], row["receipt"] = receipt["state"], receipt
		return row, nil
	})
	return receipt, e
}
