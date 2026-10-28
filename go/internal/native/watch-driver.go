package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"
)

type NativeWatchDriver interface {
	Capabilities(context.Context) (map[string]any, error)
	Run(context.Context, WatchHostRunInput) (map[string]any, error)
	Cancel(context.Context, string, map[string]any) (map[string]any, error)
	Reconcile(context.Context, map[string]any, func() bool) (map[string]any, error)
	Status(string, string) map[string]any
	Close(context.Context) error
}
type WatchHostRunInput struct {
	WatchID, Model, CWD, Purpose, ScopeKey string
	Work                                   map[string]any
	IsCurrent                              func() bool
	OnState                                func(map[string]any) error
}

func wdError(code string) error     { return fault.New(code, 409) }
func wdObject(v any) map[string]any { o, _ := v.(map[string]any); return o }
func wdText(v any) string           { s, _ := v.(string); return s }
func wdArray(v any) []any           { a, _ := v.([]any); return a }
func wdCopy(v map[string]any) map[string]any {
	out := map[string]any{}
	for k, x := range v {
		out[k] = x
	}
	return out
}
func wdTerminal(state string) bool {
	return state == "completed" || state == "failed" || state == "interrupted"
}
func wdCurrent(ctx context.Context, check func() bool) bool {
	return ctx.Err() == nil && (check == nil || check())
}
func wdOnState(input WatchHostRunInput, state map[string]any) error {
	if input.OnState != nil {
		return input.OnState(state)
	}
	return nil
}
func wdMessages(work map[string]any) []any {
	out := []any{}
	for _, v := range wdArray(work["items"]) {
		m := wdObject(v)
		id := m["messageId"]
		if id == nil {
			id = m["id"]
		}
		out = append(out, map[string]any{"messageId": id, "sequence": m["sequence"], "text": m["text"]})
	}
	return out
}
func NewConfiguredNativeWatchDriver(raw json.RawMessage) (NativeWatchDriver, map[string]any, error) {
	if len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil, nil, nil
	}
	var config map[string]any
	if protocol.Decode(raw, &config) != nil || config == nil {
		return nil, nil, wdError("native_configuration_invalid")
	}
	kind, command, cwd := wdText(config["kind"]), wdText(config["command"]), wdText(config["cwd"])
	if (kind != "codex-app-server" && kind != "claude-code") || !filepath.IsAbs(command) || !filepath.IsAbs(cwd) || utf8.RuneCountInString(command) > 4000 || utf8.RuneCountInString(cwd) > 4000 {
		return nil, nil, wdError("native_configuration_invalid")
	}
	for k := range config {
		if k != "kind" && k != "command" && k != "cwd" && (kind != "codex-app-server" || k != "disabledMcpServers") {
			return nil, nil, wdError("native_configuration_invalid")
		}
	}
	if kind == "claude-code" {
		return newWatchClaude(command, cwd), wdCopy(config), nil
	}
	disabled := []string{}
	if value, exists := config["disabledMcpServers"]; exists {
		values, ok := value.([]any)
		if !ok || len(values) > 64 {
			return nil, nil, wdError("native_configuration_invalid")
		}
		seen := map[string]bool{}
		valid := regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
		for _, v := range values {
			name, ok := v.(string)
			if !ok || !valid.MatchString(name) || seen[name] {
				return nil, nil, wdError("native_configuration_invalid")
			}
			seen[name] = true
			disabled = append(disabled, name)
		}
	}
	config["disabledMcpServers"] = disabled
	return newWatchCodex(command, cwd, disabled), wdCopy(config), nil
}
