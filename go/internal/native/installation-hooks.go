package native

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"unicode/utf16"
)

// managedHooks updates only the exact previously recorded Galaxy hook group.
// Every unrelated event, matcher and command remains in its original array.
func managedHookGroup(host, node, release, config, data string) (any, error) {
	if !filepath.IsAbs(node) || !filepath.IsAbs(release) {
		return nil, hostConfigurationFailure("setup_path_invalid")
	}
	if err := installationExecutable(node); err != nil {
		return nil, err
	}
	hook := filepath.Join(release, "host-adapters", host, "hook.mjs")
	if err := hostFile(hook); err != nil {
		return nil, err
	}
	entry, err := hostCandidate(release)
	if err != nil {
		return nil, err
	}
	args := []string{hook, "--executable", entry}
	if config != "" {
		args = append(args, "--config", config)
	} else {
		args = append(args, "--data-dir", data)
	}
	hookSpec := map[string]any{"type": "command", "timeout": 30}
	if host == "claude-code" {
		hookSpec["command"] = node
		hookSpec["args"] = args
	} else {
		tokens := append([]string{node}, args...)
		if runtime.GOOS == "windows" {
			script := "&"
			for _, token := range tokens {
				if strings.ContainsAny(token, "\x00\r\n") {
					return nil, hostConfigurationFailure("setup_hook_path_unsupported")
				}
				script += " '" + strings.ReplaceAll(token, "'", "''") + "'"
			}
			script += "; exit $LASTEXITCODE"
			words := utf16.Encode([]rune(script))
			data := make([]byte, len(words)*2)
			for i, w := range words {
				binary.LittleEndian.PutUint16(data[i*2:], w)
			}
			hookSpec["command"] = "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + base64.StdEncoding.EncodeToString(data)
		} else {
			quoted := make([]string, 0, len(tokens))
			for _, token := range tokens {
				q, e := managedShellQuote(token)
				if e != nil {
					return nil, e
				}
				quoted = append(quoted, q)
			}
			hookSpec["command"] = strings.Join(quoted, " ")
		}
	}
	events := []string{"UserPromptSubmit", "PostToolUse", "Stop"}
	if host == "claude-code" {
		events = append(events, "PostToolUseFailure")
	}
	groups := map[string]any{}
	for _, event := range events {
		item := map[string]any{}
		for k, v := range hookSpec {
			item[k] = v
		}
		groups[event] = map[string]any{"hooks": []any{item}}
	}
	rawSpec, err := json.Marshal(groups)
	if err != nil {
		return nil, err
	}
	var desired any
	if err = json.Unmarshal(rawSpec, &desired); err != nil {
		return nil, err
	}
	return desired, nil
}

func managedHooks(host, path string, desired, old, older any) error {
	if !filepath.IsAbs(path) {
		return hostConfigurationFailure("setup_path_invalid")
	}
	raw, err := os.ReadFile(path)
	missing := os.IsNotExist(err)
	if err != nil && !missing {
		return err
	}
	if missing {
		raw = []byte("{}\n")
	} else if err = hostFile(path); err != nil {
		return err
	}
	obj, err := hostConfigurationObject(string(raw))
	if err != nil {
		return err
	}
	hooks := uploadObject(obj["hooks"])
	updated := string(raw)
	events := []string{"UserPromptSubmit", "PostToolUse", "Stop"}
	if host == "claude-code" {
		events = append(events, "PostToolUseFailure")
	}
	for _, event := range events {
		var list []any
		if value, ok := hooks[event]; ok {
			var valid bool
			list, valid = value.([]any)
			if !valid {
				return hostConfigurationFailure("setup_host_config_conflict")
			}
		}
		eventDesired := managedHookEvent(desired, event)
		eventOld := managedHookEvent(old, event)
		eventOlder := managedHookEvent(older, event)
		next := []any{}
		for _, group := range list {
			if eventOld != nil && reflect.DeepEqual(group, eventOld) || eventOlder != nil && reflect.DeepEqual(group, eventOlder) {
				continue
			}
			if reflect.DeepEqual(group, eventDesired) {
				continue
			}
			next = append(next, group)
		}
		next = append(next, eventDesired)
		updated, err = hostSetConfiguration(updated, []string{"hooks", event}, next)
		if err != nil {
			return err
		}
	}
	if _, err = hostConfigurationObject(updated); err != nil {
		return err
	}
	original := string(raw)
	if missing {
		err = hostWriteNew(path, []byte(updated))
	} else {
		err = hostReplaceSelected(path, updated, &original)
	}
	if err != nil {
		return err
	}
	return nil
}
func managedShellQuote(value string) (string, error) {
	if runtime.GOOS == "windows" {
		// Both cmd and PowerShell preserve quoted paths with this restricted set.
		// Ambiguous shell metacharacters are rejected instead of interpolated.
		if strings.ContainsAny(value, "\"$`%!^&|<>;(){}\r\n") {
			return "", hostConfigurationFailure("setup_hook_path_unsupported")
		}
		return "\"" + value + "\"", nil
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return "", hostConfigurationFailure("setup_hook_path_unsupported")
	}
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'", nil
}

func removeManagedHooks(host, path string, old any) error {
	if old == nil {
		return nil
	}
	if !filepath.IsAbs(path) {
		return hostConfigurationFailure("setup_path_invalid")
	}
	if err := hostFile(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	obj, err := hostConfigurationObject(string(raw))
	if err != nil {
		return err
	}
	hooks := uploadObject(obj["hooks"])
	updated := string(raw)
	events := []string{"UserPromptSubmit", "PostToolUse", "Stop"}
	if host == "claude-code" {
		events = append(events, "PostToolUseFailure")
	}
	for _, event := range events {
		value, ok := hooks[event]
		if !ok {
			continue
		}
		list, ok := value.([]any)
		if !ok {
			return hostConfigurationFailure("setup_host_config_conflict")
		}
		eventOld := managedHookEvent(old, event)
		next := []any{}
		for _, group := range list {
			if !reflect.DeepEqual(group, eventOld) {
				next = append(next, group)
			}
		}
		updated, err = hostSetConfiguration(updated, []string{"hooks", event}, next)
		if err != nil {
			return err
		}
	}
	original := string(raw)
	return hostReplaceSelected(path, updated, &original)
}

func managedHookEvent(groups any, event string) any {
	m, ok := groups.(map[string]any)
	if !ok {
		return nil
	}
	if _, legacy := m["hooks"]; legacy {
		return groups
	}
	return m[event]
}
