package native

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type NavigationOptions struct {
	OpenBrowser func(context.Context, string) (map[string]any, error)
	Timeout     time.Duration
}
type NativeNavigation struct {
	runtime *Runtime
	options NavigationOptions
}

func NewNativeNavigation(runtime *Runtime, options NavigationOptions) *NativeNavigation {
	if options.OpenBrowser == nil {
		options.OpenBrowser = navigationPlatformOpen
	}
	if options.Timeout <= 0 {
		options.Timeout = 10 * time.Second
	}
	return &NativeNavigation{runtime, options}
}
func navigationSchema() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(navigationContractJSON), &value)
	return value
}
func navigationInputSchema() map[string]any {
	schema := navigationSchema()
	var walk func(map[string]any)
	walk = func(node map[string]any) {
		if property := uploadObject(uploadObject(node["properties"])["query"]); property != nil {
			delete(property, "minLength")
			delete(property, "maxLength")
		}
		for _, value := range node {
			if child, ok := value.(map[string]any); ok {
				walk(child)
			}
			if children, ok := value.([]any); ok {
				for _, child := range children {
					if child, ok := child.(map[string]any); ok {
						walk(child)
					}
				}
			}
		}
	}
	walk(schema)
	return schema
}
func navigationNormalize(input any) (map[string]any, error) {
	raw, e := protocol.Encode(input)
	if e != nil {
		return nil, e
	}
	var parsed map[string]any
	if protocol.Decode(raw, &parsed) != nil || parsed == nil {
		return nil, fault.New("navigation_reference_invalid", 400)
	}
	object := uploadObject(parsed["object"])
	if query, ok := object["query"].(string); ok {
		object["query"] = uploadTrim(query)
	}
	if remoteChatValidate(navigationSchema(), parsed) != nil {
		return nil, fault.New("navigation_reference_invalid", 400)
	}
	return parsed, nil
}
func navigationPath(object map[string]any) (string, error) {
	kind := text(object["kind"])
	if kind == "account" {
		if object["section"] == "association" {
			return "/app/settings/identity?section=account", nil
		}
		if object["section"] == "access" {
			return "/app/account?section=access", nil
		}
		return "/app/account", nil
	}
	routes := map[string]string{"task": "tasks", "room": "rooms", "messages": "rooms", "project": "projects", "capsule": "capsules", "capsules": "capsules", "post": "community/posts", "community": "community", "bookmarks": "bookmarks", "match": "match", "publish": "publish", "participate": "participate", "identity": "settings/identity", "privacy": "settings/privacy", "search": "search", "summaries": "settings/summaries", "notifications": "notifications"}
	route := routes[kind]
	if route == "" {
		return "", fault.New("navigation_reference_invalid", 400)
	}
	path := "/app/" + route
	if id := text(object["id"]); id != "" {
		path += "/" + id
	}
	if version := text(object["versionId"]); version != "" {
		path += "/versions/" + version
	}
	if kind == "community" {
		query := url.Values{}
		if topic := text(object["topic"]); topic != "" {
			query.Set("topic", topic)
		}
		if value := text(object["query"]); value != "" {
			query.Set("q", value)
		}
		if len(query) > 0 {
			encoded := strings.ReplaceAll(strings.ReplaceAll(query.Encode(), "~", "%7E"), "%2A", "*")
			if strings.Contains(encoded, "&topic=") {
				parts := strings.SplitN(encoded, "&", 2)
				encoded = parts[1] + "&" + parts[0]
			}
			path += "?" + encoded
		}
	}
	return path, nil
}

type navigationAuthority struct {
	runtime    *Runtime
	scope      ChoiceScope
	generation uint64
	connection connectionLease
	binding    string
}

func (n *NativeNavigation) authority(ctx context.Context) (context.Context, func(), *navigationAuthority, error) {
	operation, cancel, generation, e := n.runtime.operation(ctx, false)
	if e != nil {
		return nil, nil, nil, e
	}
	scope, e := n.runtime.store.ChoiceScope(operation)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	connection, e := n.runtime.connection.lease(operation, false)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	snapshot, e := n.runtime.connection.Snapshot(operation)
	if e != nil {
		cancel()
		return nil, nil, nil, e
	}
	binding := ""
	if snapshot != nil {
		binding = snapshot.BindingID
	}
	authority := &navigationAuthority{n.runtime, scope, generation, connection, binding}
	if e = authority.check(operation); e != nil {
		cancel()
		return nil, nil, nil, e
	}
	return operation, cancel, authority, nil
}
func (a *navigationAuthority) check(ctx context.Context) error {
	if e := a.runtime.checkOperation(a.generation); e != nil {
		return e
	}
	if e := a.runtime.connection.check(ctx, a.connection); e != nil {
		return fault.New("receipt_status_authority_changed", 409)
	}
	snapshot, e := a.runtime.connection.Snapshot(ctx)
	if e != nil {
		return e
	}
	binding := ""
	if snapshot != nil {
		binding = snapshot.BindingID
	}
	if binding != a.binding {
		return fault.New("receipt_status_authority_changed", 409)
	}
	return a.runtime.store.With(ctx, false, func(dir string) error {
		if e := a.runtime.store.verifyChoiceWithin(dir, &a.scope); e != nil {
			return fault.New("receipt_status_authority_changed", 409)
		}
		return nil
	})
}
func (a *navigationAuthority) owner() map[string]any {
	return map[string]any{"subjectId": nullableText(a.scope.Owner), "endpoint": a.scope.Endpoint, "website": a.runtime.config.Website}
}
func (a *navigationAuthority) save(ctx context.Context, id string, record map[string]any) error {
	if e := a.check(ctx); e != nil {
		return e
	}
	e := a.runtime.store.With(ctx, true, func(dir string) error {
		if e := a.runtime.store.verifyChoiceWithin(dir, &a.scope); e != nil {
			return e
		}
		selected, e := a.runtime.connection.selectionWithin(dir)
		if e != nil {
			return e
		}
		if selected.fingerprint != a.connection.selection.fingerprint {
			return fault.New("receipt_status_authority_changed", 409)
		}
		if e = os.MkdirAll(filepath.Join(dir, "native-v2", "records"), 0700); e != nil {
			return e
		}
		return writeJSON(connectionRecordPath(dir, "navigation:"+id), record)
	})
	if e != nil {
		return e
	}
	return a.check(ctx)
}
func (n *NativeNavigation) prepare(ctx context.Context, input any) (map[string]any, *navigationAuthority, context.Context, func(), error) {
	parsed, e := navigationNormalize(input)
	if e != nil {
		return nil, nil, nil, nil, e
	}
	operation, cancel, authority, e := n.authority(ctx)
	if e != nil {
		return nil, nil, nil, nil, e
	}
	path, e := navigationPath(uploadObject(parsed["object"]))
	if e != nil {
		cancel()
		return nil, nil, nil, nil, e
	}
	id := uuid.NewString()
	record := identityClone(parsed)
	record["navigationId"], record["owner"], record["createdAt"], record["targetPath"] = id, authority.owner(), n.runtime.connection.now().Unix(), path
	if e = authority.save(operation, id, record); e != nil {
		cancel()
		return nil, nil, nil, nil, e
	}
	return map[string]any{"navigationId": id, "targetPath": path, "url": n.runtime.config.Website + path, "object": parsed["object"], "state": "prepared", "businessMutation": false, "opened": false, "returnMode": "mcp-refresh"}, authority, operation, cancel, nil
}
func (n *NativeNavigation) Prepare(ctx context.Context, input any) (map[string]any, error) {
	result, _, _, cancel, e := n.prepare(ctx, input)
	if e != nil {
		return nil, e
	}
	defer cancel()
	return result, nil
}
func (n *NativeNavigation) Open(ctx context.Context, input any) (map[string]any, error) {
	prepared, authority, operation, cancel, e := n.prepare(ctx, input)
	if e != nil {
		return nil, e
	}
	defer cancel()
	launchCtx, stop := context.WithTimeout(operation, n.options.Timeout)
	defer stop()
	type launchResult struct {
		value map[string]any
		e     error
	}
	done := make(chan launchResult, 1)
	go func() {
		value, e := n.options.OpenBrowser(launchCtx, text(prepared["url"]))
		done <- launchResult{value, e}
	}()
	launch := map[string]any{"state": "launch-timeout", "launched": false}
	select {
	case result := <-done:
		if launchCtx.Err() != nil && operation.Err() == nil {
			break
		}
		if result.e != nil {
			launch = map[string]any{"state": "launch-failed", "launched": false}
		} else {
			launch = result.value
		}
	case <-launchCtx.Done():
		if operation.Err() != nil {
			return nil, operation.Err()
		}
	}
	if e = authority.check(operation); e != nil {
		return nil, e
	}
	result := map[string]any{"navigationId": prepared["navigationId"], "targetPath": prepared["targetPath"], "url": prepared["url"], "surface": "browser", "opened": "unverified", "businessMutation": false, "returnMode": "mcp-refresh", "embeddedUi": "unverified"}
	for key, value := range launch {
		if isOne(key, "state", "launched") {
			result[key] = value
		}
	}
	return result, nil
}
func (n *NativeNavigation) refresh(ctx context.Context, object map[string]any, scope *ChoiceScope) (map[string]any, error) {
	options := ConnectionCallOptions{ExpectedScope: scope}
	id := text(object["id"])
	path := ""
	body := any(map[string]any{})
	switch object["kind"] {
	case "task":
		path = "/v2/tasks/" + id
		options.Method = "GET"
		body = nil
	case "room":
		path = "/v2/chat/rooms/" + id + "/read"
	case "project":
		path = "/v2/projects/" + id
		options.Method = "GET"
		body = nil
	case "capsule":
		path = "/v2/capsules/read"
		body = map[string]any{"capsuleId": id}
		if version := text(object["versionId"]); version != "" {
			body.(map[string]any)["versionId"] = version
		}
	case "post":
		path = "/v2/community/posts/" + id
		if version := text(object["versionId"]); version != "" {
			path += "/versions/" + version
		}
		options.Method = "GET"
		options.Unauthenticated = true
		body = nil
	default:
		return map[string]any{"state": "browser-detail-required", "object": object}, nil
	}
	return n.runtime.Call(ctx, path, body, options)
}
func navigationUnavailable(e error) bool {
	var response *ConnectionHTTPError
	if !errors.As(e, &response) {
		return false
	}
	return ((response.Status == 403 || response.Status == 404 || response.Status == 410 || response.Status == 429) || response.Status >= 500 && response.Status < 600) && !isOne(response.Code, "unauthorized", "binding_revoked", "invalid_session", "session_expired", "access_denied")
}
func (n *NativeNavigation) Resume(ctx context.Context, id string) (map[string]any, error) {
	if !controlUUID(id) {
		return nil, fault.New("navigation_reference_invalid", 400)
	}
	operation, cancel, authority, e := n.authority(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	var record map[string]any
	e = n.runtime.store.With(operation, false, func(dir string) error {
		if e := n.runtime.store.verifyChoiceWithin(dir, &authority.scope); e != nil {
			return e
		}
		_, e := readJSON(connectionRecordPath(dir, "navigation:"+id), &record)
		return e
	})
	if e != nil {
		return nil, e
	}
	if e = authority.check(operation); e != nil {
		return nil, e
	}
	if record == nil {
		return nil, fault.New("navigation_not_found", 404)
	}
	if record["owner"] == nil {
		return nil, fault.New("navigation_owner_unconfirmed", 409)
	}
	if !connectionEqual(record["owner"], authority.owner()) {
		return nil, fault.New("navigation_scope_changed", 409)
	}
	input := map[string]any{"object": record["object"]}
	if record["origin"] != nil {
		input["origin"] = record["origin"]
	}
	parsed, e := navigationNormalize(input)
	if e != nil {
		return nil, e
	}
	object := uploadObject(parsed["object"])
	path, e := navigationPath(object)
	if e != nil || record["navigationId"] != id || record["targetPath"] != path {
		return nil, fault.New("navigation_reference_invalid", 409)
	}
	var data any
	var sourceError any
	current := false
	if text(object["id"]) != "" {
		fresh, requestError := n.refresh(operation, object, &authority.scope)
		if e = authority.check(operation); e != nil {
			return nil, e
		}
		if requestError != nil {
			if !navigationUnavailable(requestError) {
				return nil, requestError
			}
			code := runtimeErrorCode(requestError)
			if !regexp.MustCompile(`^[a-z0-9_:-]{1,100}$`).MatchString(code) {
				code = "navigation_source_unavailable"
			}
			sourceError = code
		} else {
			reference := fresh
			if object["kind"] == "post" {
				reference = uploadObject(fresh["locator"])
			}
			if reference[text(object["kind"])+"Id"] != object["id"] || object["versionId"] != nil && reference["versionId"] != object["versionId"] {
				return nil, fault.New("navigation_source_reference_mismatch", 409)
			}
			if object["kind"] == "post" && fresh["availability"] != "available" {
				availability := text(fresh["availability"])
				if !isOne(availability, "withdrawn", "expired", "unavailable") {
					availability = "unavailable"
				}
				sourceError = "forum_content_" + availability
			} else {
				data = fresh
				current = true
			}
		}
	}
	state := "navigation-only"
	if sourceError != nil {
		state = "unavailable"
	} else if current {
		state = "refreshed"
	}
	if e = authority.check(operation); e != nil {
		return nil, e
	}
	return map[string]any{"navigationId": id, "origin": parsed["origin"], "object": object, "data": data, "current": current, "sourceError": sourceError, "state": state, "businessMutation": false, "returnedToHost": "host-controlled", "closedWindowDoesNotCancel": true}, nil
}
