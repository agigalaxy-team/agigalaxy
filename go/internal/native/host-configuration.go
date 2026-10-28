package native

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type HostConfigurationInput struct {
	PackageDirectory string   `json:"packageDirectory"`
	ConfigPath       string   `json:"configPath"`
	Destination      string   `json:"destination"`
	Hosts            []string `json:"hosts"`
	DataDirectory    string   `json:"dataDirectory,omitempty"`
	Endpoint         string   `json:"endpoint,omitempty"`
}

func HostConfigurationOptions() []map[string]string {
	return []map[string]string{{"id": "opencode", "label": "OpenCode"}, {"id": "claude-code", "label": "Claude Code"}, {"id": "github-copilot", "label": "GitHub Copilot（VS Code）"}, {"id": "codex", "label": "Codex"}, {"id": "cursor", "label": "Cursor"}, {"id": "workbuddy", "label": "WorkBuddy"}, {"id": "trae-desktop", "label": "TRAE / TraeWork"}, {"id": "hermes", "label": "Hermes Agent"}, {"id": "deepseek-harness", "label": "DeepSeek Harness"}}
}
func hostConfigurationFailure(code string) error { return fault.New(code, 409) }
func hostFile(path string) error {
	info, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() {
		return hostConfigurationFailure("setup_package_invalid")
	}
	return nil
}
func hostCandidate(directory string) (string, error) {
	var manifest struct {
		Kind    string `json:"kind"`
		Backend string `json:"backend"`
		MCP     struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
		} `json:"mcp"`
	}
	if _, e := readJSON(filepath.Join(directory, "native-v2.json"), &manifest); e != nil {
		return "", e
	}
	if manifest.Kind != "galaxy-native-go-local-candidate" || manifest.Backend != "go" || !isOne(manifest.MCP.Command, "galaxy", "galaxy.exe") || len(manifest.MCP.Args) != 1 || manifest.MCP.Args[0] != "native" {
		return "", hostConfigurationFailure("setup_package_invalid")
	}
	entry := filepath.Join(directory, manifest.MCP.Command)
	if e := hostFile(entry); e != nil {
		return "", e
	}
	return entry, nil
}
func hostJSON(value any) ([]byte, error) {
	raw, e := protocol.Encode(value)
	if e != nil {
		return nil, e
	}
	var result bytes.Buffer
	if e = json.Indent(&result, raw, "", "  "); e != nil {
		return nil, e
	}
	return append(result.Bytes(), '\n'), nil
}

// Exclusive file publication and source-only copying never inspect a user's
// host profile. Existing output is preserved, including on a partial failure.
func hostWriteNew(path string, raw []byte) error {
	if e := os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	file, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, writeError := file.Write(raw)
	closeError := file.Close()
	if writeError != nil {
		return writeError
	}
	return closeError
}
func hostCopyTree(source, target string, skip ...string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return hostConfigurationFailure("setup_package_invalid")
		}
		relative, e := filepath.Rel(source, path)
		if e != nil {
			return e
		}
		for _, name := range skip {
			if relative == name {
				return nil
			}
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			if relative == "." {
				return os.Mkdir(destination, 0700)
			}
			return os.MkdirAll(destination, 0700)
		}
		if !entry.Type().IsRegular() {
			return hostConfigurationFailure("setup_package_invalid")
		}
		input, e := os.Open(path)
		if e != nil {
			return e
		}
		defer input.Close()
		info, e := entry.Info()
		if e != nil {
			return e
		}
		output, e := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if e != nil {
			return e
		}
		_, copyError := io.Copy(output, input)
		closeError := output.Close()
		if copyError != nil {
			return copyError
		}
		return closeError
	})
}
func hostFileURL(path string) string {
	path = filepath.ToSlash(path)
	if runtime.GOOS == "windows" && strings.HasPrefix(path, "//") {
		parts := strings.SplitN(strings.TrimPrefix(path, "//"), "/", 2)
		if len(parts) == 2 {
			return (&url.URL{Scheme: "file", Host: parts[0], Path: "/" + parts[1]}).String()
		}
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return (&url.URL{Scheme: "file", Path: path}).String()
}
func hostJSONString(value any) string { raw, _ := protocol.Encode(value); return string(raw) }
func hostOpenCodePlugin(input HostConfigurationInput) string {
	return "import {createNativeGalaxyPlugin} from " + hostJSONString(hostFileURL(filepath.Join(input.PackageDirectory, "opencode.js"))) + ";\nexport default createNativeGalaxyPlugin(" + hostJSONString(map[string]any{"backend": "go", "executable": hostExecutable(input.PackageDirectory), "configPath": input.ConfigPath, "dataDirectory": input.DataDirectory, "endpoint": input.Endpoint}) + ");\n"
}
func hostExecutable(directory string) string { entry, _ := hostCandidate(directory); return entry }

func GenerateHostConfigurations(ctx context.Context, input HostConfigurationInput) (map[string]any, error) {
	if input.Hosts == nil {
		for _, option := range HostConfigurationOptions() {
			if option["id"] != "opencode" {
				input.Hosts = append(input.Hosts, option["id"])
			}
		}
	}
	for _, path := range []string{input.PackageDirectory, input.ConfigPath, input.Destination} {
		if !filepath.IsAbs(path) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
	}
	entry, e := hostCandidate(input.PackageDirectory)
	if e != nil {
		return nil, e
	}
	if e = hostFile(input.ConfigPath); e != nil {
		return nil, e
	}
	if len(input.Hosts) == 0 {
		return nil, hostConfigurationFailure("setup_host_invalid")
	}
	selected := map[string]bool{}
	for _, host := range input.Hosts {
		valid := false
		for _, option := range HostConfigurationOptions() {
			if option["id"] == host {
				valid = true
			}
		}
		if !valid || selected[host] {
			return nil, hostConfigurationFailure("setup_host_invalid")
		}
		selected[host] = true
	}
	for _, path := range []string{"skills/galaxy/SKILL.md", "host-capabilities.json", "HOSTS.md"} {
		if e = hostFile(filepath.Join(input.PackageDirectory, filepath.FromSlash(path))); e != nil {
			return nil, e
		}
	}
	if selected["opencode"] {
		if !filepath.IsAbs(input.DataDirectory) || !serviceConfigurationOrigin(input.Endpoint) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
		if e = hostFile(filepath.Join(input.PackageDirectory, "opencode.js")); e != nil {
			return nil, e
		}
	}
	if selected["codex"] {
		if e = hostFile(filepath.Join(input.PackageDirectory, "host-templates", "codex", "galaxy-native-v2", ".codex-plugin", "plugin.json")); e != nil {
			return nil, e
		}
	}
	if e = os.Mkdir(input.Destination, 0700); e != nil {
		return nil, e
	}
	outputs := map[string]string{}
	save := func(name string, value any) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		var raw []byte
		var e error
		if text, ok := value.(string); ok {
			raw = []byte(text)
		} else {
			raw, e = hostJSON(value)
			if e != nil {
				return e
			}
		}
		if e = hostWriteNew(filepath.Join(input.Destination, filepath.FromSlash(name)), raw); e != nil {
			return e
		}
		outputs[name] = identity.Digest(raw)
		return nil
	}
	skill := func(name string) error {
		target := filepath.Join(input.Destination, filepath.FromSlash(name))
		if e := os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return e
		}
		return hostCopyTree(filepath.Join(input.PackageDirectory, "skills", "galaxy"), target)
	}
	spec := map[string]any{"type": "stdio", "command": entry, "args": []string{"native"}, "env": map[string]string{"GALAXY_NATIVE_CONFIG": input.ConfigPath}}
	mcp := map[string]any{"mcpServers": map[string]any{"galaxy": spec}}
	// Each format remains the original host format; only the actual core command
	// changes from Node/galaxy.js to the selected candidate's Go native command.
	operations := []func() error{}
	add := func(name string, value any) {
		operations = append(operations, func() error { return save(name, value) })
	}
	addSkill := func(name string) { operations = append(operations, func() error { return skill(name) }) }
	if selected["opencode"] {
		add("opencode/opencode.json", map[string]any{"$schema": "https://opencode.ai/config.json", "mcp": map[string]any{"galaxy": map[string]any{"type": "local", "command": []string{entry, "native"}, "environment": spec["env"], "enabled": true}}, "skills": map[string]any{"paths": []string{filepath.Join(input.Destination, "opencode", ".agents", "skills")}}})
		add("opencode/galaxy.tui.mjs", hostOpenCodePlugin(input))
		add("opencode/tui.json", map[string]any{"$schema": "https://opencode.ai/tui.json", "plugin": []string{hostFileURL(filepath.Join(input.Destination, "opencode", "galaxy.tui.mjs"))}})
		addSkill("opencode/.agents/skills/galaxy")
	}
	if selected["claude-code"] {
		add("claude-code/.mcp.json", mcp)
		addSkill("claude-code/.claude/skills/galaxy")
		add("claude-desktop-chat/claude_desktop_config.fragment.json", mcp)
	}
	if selected["github-copilot"] {
		add("copilot-vscode/.vscode/mcp.json", map[string]any{"servers": map[string]any{"galaxy": spec}})
		addSkill("copilot-vscode/.github/skills/galaxy")
	}
	if selected["codex"] {
		add("codex/config.fragment.toml", "[mcp_servers.galaxy]\ncommand = "+hostJSONString(entry)+"\nargs = [\"native\"]\n\n[mcp_servers.galaxy.env]\nGALAXY_NATIVE_CONFIG = "+hostJSONString(input.ConfigPath)+"\n")
		addSkill("codex/.agents/skills/galaxy")
		operations = append(operations, func() error {
			target := filepath.Join(input.Destination, "codex", "galaxy-native-v2")
			if e := hostCopyTree(filepath.Join(input.PackageDirectory, "host-templates", "codex", "galaxy-native-v2"), target, ".mcp.json"); e != nil {
				return e
			}
			return save("codex/galaxy-native-v2/.mcp.json", mcp)
		})
		addSkill("codex/galaxy-native-v2/skills/galaxy")
	}
	if selected["cursor"] {
		add("cursor/.cursor/mcp.json", mcp)
		addSkill("cursor/.cursor/skills/galaxy")
	}
	if selected["workbuddy"] {
		add("workbuddy/galaxy-native-v2/mcp.json", mcp)
		add("workbuddy/galaxy-native-v2/connector-meta.json", map[string]any{"name": "银河", "name_zh": "银河", "name_en": "Galaxy", "description": "Find collaboration, tasks and permitted help through your own Agent.", "description_zh": "使用自己的模型发现协助、发布或参与任务，通过浏览器进入银河房间。", "description_en": "Use your own Agent for assistance and shared tasks; open full rooms in your browser.", "source": "galaxy-native-v2", "type": "mcp", "version": "0.2.0", "minWorkbuddyVersion": "4.24.0", "examples_zh": []string{"打开银河的匹配、发布和参与入口", "为这个问题找可参与协助的人或 Agent"}, "examples_en": []string{"Open Galaxy matching, publishing and participation", "Find relevant people or Agents who can help"}})
		add("workbuddy/galaxy-native-v2/icon.svg", hostWorkbuddyIcon)
		addSkill("workbuddy/galaxy-native-v2/skills/galaxy")
	}
	if selected["trae-desktop"] {
		add("trae-work/mcp.local.json", mcp)
		addSkill("trae-work/.trae/skills/galaxy")
	}
	if selected["hermes"] {
		add("hermes/config.fragment.yaml", "mcp_servers:\n  galaxy:\n    command: "+hostJSONString(entry)+"\n    args: [\"native\"]\n    env:\n      GALAXY_NATIVE_CONFIG: "+hostJSONString(input.ConfigPath)+"\n")
		addSkill("hermes/skills/galaxy")
	}
	if selected["deepseek-harness"] {
		add("deepseek-harness/mcp-plugin.fragment.json", map[string]any{"id": "mcp-galaxy", "name": "@deepseek-ai/dsh-mcp-client", "config": map[string]any{"serverName": "galaxy", "transport": "stdio", "command": entry, "args": []string{"native"}, "env": spec["env"]}})
		addSkill("deepseek-harness/.dsh/skills/galaxy")
	}
	for _, run := range operations {
		if e = run(); e != nil {
			return nil, e
		}
	}
	var matrix any
	if _, e = readJSON(filepath.Join(input.PackageDirectory, "host-capabilities.json"), &matrix); e != nil {
		return nil, e
	}
	if e = save("host-capabilities.json", matrix); e != nil {
		return nil, e
	}
	instructions, e := os.ReadFile(filepath.Join(input.PackageDirectory, "HOSTS.md"))
	if e != nil {
		return nil, e
	}
	if e = save("INSTALL.md", string(instructions)); e != nil {
		return nil, e
	}
	result := map[string]any{"schemaVersion": 1, "packageDirectory": input.PackageDirectory, "publicConfigPath": input.ConfigPath, "generatedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"), "hosts": input.Hosts, "hostCount": len(input.Hosts), "hostRuntimeTested": false, "marketplacePublished": false, "actualSettingsModified": false, "traeCommandRequiresHostPathResolution": false, "outputs": outputs}
	if e = save("generated-configs.json", result); e != nil {
		return nil, e
	}
	result["destination"] = input.Destination
	return result, nil
}

const hostWorkbuddyIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="#6650df" stroke-width="3"><ellipse cx="32" cy="32" rx="27" ry="13" transform="rotate(-30 32 32)"/><ellipse cx="32" cy="32" rx="13" ry="27" transform="rotate(-30 32 32)"/></g><circle cx="32" cy="32" r="6" fill="#6650df"/><circle cx="52" cy="17" r="4" fill="#ad69e0"/></svg>` + "\n"
