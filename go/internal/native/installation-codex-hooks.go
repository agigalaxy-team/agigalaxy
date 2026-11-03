package native

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type managedCodexHookTrust struct {
	Key         string `json:"key"`
	CurrentHash string `json:"currentHash"`
	EventName   string `json:"eventName"`
}

// adoptCodexHooks uses Codex's own discovery and trust-state API. It never
// enables hooks or trusts any definition other than this installation's three.
func codexHooksRPC(ctx context.Context, command, hookPath string) (context.Context, *watchRPC, string, func(), error) {
	cwd, err := os.Getwd()
	if err != nil || !filepath.IsAbs(cwd) || !filepath.IsAbs(hookPath) {
		return nil, nil, "", nil, errors.New("host_context_unavailable")
	}
	executable, prefix, err := ResolveHostCommand("codex", command)
	if err != nil {
		return nil, nil, "", nil, err
	}
	rpcCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	environment := make([]string, 0, len(os.Environ())+1)
	for _, value := range os.Environ() {
		if name, _, ok := strings.Cut(value, "="); ok && strings.EqualFold(name, "CODEX_HOME") {
			continue
		}
		environment = append(environment, value)
	}
	environment = append(environment, "CODEX_HOME="+filepath.Dir(hookPath))
	rpc := newWatchRPC(executable, cwd, append(prefix, "app-server"))
	rpc.env = environment
	closeRPC := func() { cancel(); _ = rpc.close(context.Background()) }
	initialized, err := rpc.request(rpcCtx, "initialize", map[string]any{"clientInfo": map[string]any{"name": "galaxy_install", "version": "1"}})
	if err != nil || !installationSamePath(text(initialized["codexHome"]), filepath.Dir(hookPath)) {
		closeRPC()
		return nil, nil, "", nil, errors.New("codex_home_unavailable")
	}
	if err = rpc.notify("initialized", map[string]any{}); err != nil {
		closeRPC()
		return nil, nil, "", nil, err
	}
	return rpcCtx, rpc, cwd, closeRPC, nil
}

func adoptCodexHooks(ctx context.Context, command, hookPath string, group any, prior []managedCodexHookTrust, tracked *[]managedCodexHookTrust) (string, error) {
	ctx, rpc, cwd, closeRPC, err := codexHooksRPC(ctx, command, hookPath)
	if err != nil {
		return "unavailable", err
	}
	defer closeRPC()
	request := func(method string, params map[string]any) (map[string]any, error) {
		return rpc.request(ctx, method, params)
	}
	configuration, configErr := request("config/read", map[string]any{"cwd": cwd, "includeLayers": false})
	if configErr != nil {
		return "unavailable", configErr
	}
	if uploadObject(uploadObject(configuration["config"])["features"])["hooks"] == false {
		return "disabled-by-host", nil
	}
	find := func() (map[string]map[string]any, string, error) {
		response, e := request("hooks/list", map[string]any{"cwds": []string{cwd}})
		if e != nil {
			return nil, "unavailable", e
		}
		expected := map[string]string{"userPromptSubmit": "UserPromptSubmit", "postToolUse": "PostToolUse", "stop": "Stop"}
		found := map[string]map[string]any{}
		for _, value := range uploadRows(response["data"]) {
			entry := uploadObject(value)
			if !installationSamePath(text(entry["cwd"]), cwd) {
				continue
			}
			if len(uploadRows(entry["errors"])) > 0 {
				return nil, "unavailable", errors.New("codex_hooks_list_failed")
			}
			for _, item := range uploadRows(entry["hooks"]) {
				hook := uploadObject(item)
				event := text(hook["eventName"])
				name, ok := expected[event]
				if !ok || hook["source"] != "user" || hook["handlerType"] != "command" || hook["isManaged"] != false || !installationSamePath(text(hook["sourcePath"]), hookPath) {
					continue
				}
				groups := uploadObject(managedHookEvent(group, name))
				handlers := uploadRows(groups["hooks"])
				if len(handlers) != 1 || hook["command"] != uploadObject(handlers[0])["command"] {
					continue
				}
				if found[event] != nil || text(hook["key"]) == "" || text(hook["currentHash"]) == "" {
					return nil, "unavailable", errors.New("codex_hook_match_ambiguous")
				}
				found[event] = hook
			}
		}
		if len(found) != len(expected) {
			return nil, "unavailable", errors.New("codex_hook_match_incomplete")
		}
		for _, hook := range found {
			if hook["enabled"] != true {
				return found, "disabled-by-host", nil
			}
		}
		return found, "available", nil
	}
	found, status, err := find()
	if err != nil || status != "available" {
		return status, err
	}
	updates := map[string]any{}
	expectedHashes := map[string]string{}
	for _, hook := range found {
		key, hash := text(hook["key"]), text(hook["currentHash"])
		if _, duplicate := expectedHashes[key]; duplicate {
			return "unavailable", errors.New("codex_hook_match_ambiguous")
		}
		expectedHashes[key] = hash
		if hook["trustStatus"] == "trusted" {
			continue
		}
		if hook["trustStatus"] != "untrusted" && hook["trustStatus"] != "modified" {
			return "requires-host-trust", nil
		}
		updates[key] = map[string]any{"trusted_hash": hash}
	}
	if len(updates) > 0 {
		_, err = request("config/batchWrite", map[string]any{"edits": []any{map[string]any{"keyPath": "hooks.state", "value": updates, "mergeStrategy": "upsert"}}, "filePath": nil, "expectedVersion": nil, "reloadUserConfig": true})
		if err != nil {
			return "requires-host-trust", err
		}
		for _, event := range []string{"userPromptSubmit", "postToolUse", "stop"} {
			hook := found[event]
			if updates[text(hook["key"])] != nil {
				*tracked = append(*tracked, managedCodexHookTrust{Key: text(hook["key"]), CurrentHash: text(hook["currentHash"]), EventName: event})
			}
		}
	}
	found, status, err = find()
	if err != nil || status != "available" {
		return status, err
	}
	for _, hook := range found {
		if hook["trustStatus"] != "trusted" || expectedHashes[text(hook["key"])] != text(hook["currentHash"]) {
			return "requires-host-trust", nil
		}
	}
	for _, event := range []string{"userPromptSubmit", "postToolUse", "stop"} {
		hook := found[event]
		key := text(hook["key"])
		hash := text(hook["currentHash"])
		owned := false
		for _, old := range prior {
			if old.Key == key && old.CurrentHash == hash && old.EventName == event {
				owned = true
			}
		}
		if owned && updates[key] == nil {
			*tracked = append(*tracked, managedCodexHookTrust{Key: key, CurrentHash: hash, EventName: event})
		}
	}
	return "trusted", nil
}

// clearCodexHookTrust removes only trust fields recorded as Galaxy's own and
// still associated with the same enabled hook and exact user-layer value.
func clearCodexHookTrust(ctx context.Context, command string, record *managedNativeRecord) ([]managedCodexHookTrust, error) {
	if record == nil || len(record.CodexHookTrust) == 0 {
		return nil, nil
	}
	remaining := append([]managedCodexHookTrust(nil), record.CodexHookTrust...)
	ctx, rpc, cwd, closeRPC, err := codexHooksRPC(ctx, command, record.HookPath)
	if err != nil {
		return remaining, err
	}
	defer closeRPC()
	list, err := rpc.request(ctx, "hooks/list", map[string]any{"cwds": []string{cwd}})
	if err != nil {
		return remaining, err
	}
	events := map[string]string{"userPromptSubmit": "UserPromptSubmit", "postToolUse": "PostToolUse", "stop": "Stop"}
	matched := map[string]bool{}
	for _, raw := range uploadRows(list["data"]) {
		entry := uploadObject(raw)
		if !installationSamePath(text(entry["cwd"]), cwd) {
			continue
		}
		if len(uploadRows(entry["errors"])) != 0 {
			return remaining, errors.New("codex_hooks_list_failed")
		}
		for _, rawHook := range uploadRows(entry["hooks"]) {
			hook := uploadObject(rawHook)
			name := events[text(hook["eventName"])]
			if name == "" || hook["source"] != "user" || hook["handlerType"] != "command" || hook["isManaged"] != false || hook["enabled"] != true || !installationSamePath(text(hook["sourcePath"]), record.HookPath) {
				continue
			}
			group := uploadObject(managedHookEvent(record.HookGroup, name))
			handlers := uploadRows(group["hooks"])
			if len(handlers) != 1 || hook["command"] != uploadObject(handlers[0])["command"] {
				continue
			}
			for _, owned := range remaining {
				if owned.Key == text(hook["key"]) && owned.EventName == text(hook["eventName"]) && owned.CurrentHash == text(hook["currentHash"]) {
					matched[owned.Key] = true
				}
			}
		}
	}
	config, err := rpc.request(ctx, "config/read", map[string]any{"cwd": cwd, "includeLayers": true})
	if err != nil {
		return remaining, err
	}
	configPath := filepath.Join(filepath.Dir(record.HookPath), "config.toml")
	var layer map[string]any
	for _, raw := range uploadRows(config["layers"]) {
		candidate := uploadObject(raw)
		name := uploadObject(candidate["name"])
		if name["type"] == "user" && name["profile"] == nil && candidate["disabledReason"] == nil && installationSamePath(text(name["file"]), configPath) {
			if layer != nil {
				return remaining, errors.New("codex_user_layer_ambiguous")
			}
			layer = candidate
		}
	}
	if layer == nil || text(layer["version"]) == "" {
		return remaining, errors.New("codex_user_layer_unavailable")
	}
	state := uploadObject(uploadObject(uploadObject(layer["config"])["hooks"])["state"])
	var edits []any
	cleared := map[string]bool{}
	for _, owned := range remaining {
		if !matched[owned.Key] {
			continue
		}
		value := uploadObject(state[owned.Key])
		if value == nil || value["trusted_hash"] == nil {
			cleared[owned.Key] = true
			continue
		}
		if value["trusted_hash"] != owned.CurrentHash || value["enabled"] == false {
			continue
		}
		quoted, _ := json.Marshal(owned.Key)
		edits = append(edits, map[string]any{"keyPath": "hooks.state." + string(quoted) + ".trusted_hash", "value": nil, "mergeStrategy": "replace"})
		cleared[owned.Key] = true
	}
	if len(edits) > 0 {
		_, err = rpc.request(ctx, "config/batchWrite", map[string]any{"edits": edits, "filePath": configPath, "expectedVersion": layer["version"], "reloadUserConfig": true})
		if err != nil {
			return remaining, err
		}
	}
	left := make([]managedCodexHookTrust, 0, len(remaining))
	for _, owned := range remaining {
		if !cleared[owned.Key] {
			left = append(left, owned)
		}
	}
	if len(left) > 0 {
		return left, errors.New("codex_owned_trust_retained")
	}
	return left, nil
}
