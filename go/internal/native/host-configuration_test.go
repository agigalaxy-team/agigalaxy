package native

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func installationFixturePackage(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "package")
	if e := os.Mkdir(dir, 0700); e != nil {
		t.Fatal(e)
	}
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	source := filepath.Join(root, "integrations", "native-v2")
	for _, item := range []struct{ source, target string }{{"skills", "skills"}, {"codex", "host-templates/codex"}} {
		target := filepath.Join(dir, filepath.FromSlash(item.target))
		if e := os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			t.Fatal(e)
		}
		if e := hostCopyTree(filepath.Join(source, item.source), target); e != nil {
			t.Fatal(e)
		}
	}
	matrix, e := os.ReadFile(filepath.Join(source, "host-capabilities.json"))
	if e != nil {
		t.Fatal(e)
	}
	for name, value := range map[string]string{"galaxy.exe": "synthetic binary fixture", "galaxy": "synthetic binary fixture", "opencode.js": "export function createNativeGalaxyPlugin(options){return options}", "opencode-v2.js": "export function createNativeGalaxyPluginV2(options){return options}", "opencode-v2-server.js": "export function createNativeGalaxyServerPluginV2(options){return options}", "HOSTS.md": "Original-format isolated host instructions", "host-capabilities.json": string(matrix), "package.json": `{"name":"isolated-candidate","dependencies":{}}`} {
		if e = os.WriteFile(filepath.Join(dir, name), []byte(value), 0700); e != nil {
			t.Fatal(e)
		}
	}
	if e = writeJSON(filepath.Join(dir, "native-v2.json"), map[string]any{"kind": "galaxy-native-go-local-candidate", "backend": "go", "mcp": map[string]any{"command": "galaxy.exe", "args": []string{"native"}}}); e != nil {
		t.Fatal(e)
	}
	return dir
}
func TestHostConfigurationSelectedFormatsAndOriginalAssets(t *testing.T) {
	ctx := context.Background()
	pkg := installationFixturePackage(t)
	root := t.TempDir()
	config := filepath.Join(root, "public.json")
	if e := os.WriteFile(config, []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	hosts := []string{}
	for _, host := range HostConfigurationOptions() {
		hosts = append(hosts, host["id"])
	}
	input := HostConfigurationInput{PackageDirectory: pkg, ConfigPath: config, Destination: filepath.Join(root, "generated"), Hosts: hosts, DataDirectory: filepath.Join(root, "data"), Endpoint: "https://api.configuration.invalid"}
	result, e := GenerateHostConfigurations(ctx, input)
	if e != nil {
		t.Fatal(e)
	}
	if result["hostCount"] != len(hosts) || result["actualSettingsModified"] != false {
		t.Fatal(result)
	}
	paths := []string{"claude-code/.mcp.json", "claude-desktop-chat/claude_desktop_config.fragment.json", "cursor/.cursor/mcp.json", "workbuddy/galaxy-native-v2/mcp.json", "trae-work/mcp.local.json", "codex/galaxy-native-v2/.mcp.json", "copilot-cli/mcp-config.json"}
	for _, path := range paths {
		var value map[string]any
		if _, e = readJSON(filepath.Join(input.Destination, filepath.FromSlash(path)), &value); e != nil {
			t.Fatal(e)
		}
		spec := uploadObject(uploadObject(value["mcpServers"])["galaxy"])
		if spec["command"] != filepath.Join(pkg, "galaxy.exe") || !connectionEqual(spec["args"], []string{"native"}) {
			t.Fatal("wrong Go command", path, spec)
		}
		if path == "copilot-cli/mcp-config.json" && !connectionEqual(spec["tools"], []string{"*"}) {
			t.Fatal("wrong Copilot CLI tools", spec)
		}
	}
	for _, path := range []string{"opencode/opencode.json", "copilot-vscode/.vscode/mcp.json", "deepseek-harness/mcp-plugin.fragment.json", "codex/config.fragment.toml", "hermes/config.fragment.yaml"} {
		raw, e := os.ReadFile(filepath.Join(input.Destination, filepath.FromSlash(path)))
		if e != nil || !strings.Contains(string(raw), "native") || strings.Contains(string(raw), "galaxy.js") {
			t.Fatal("non-Go host spec", path, e)
		}
	}
	if _, e = GenerateHostConfigurations(ctx, input); !os.IsExist(e) {
		t.Fatal("existing output overwritten", e)
	}
	for _, path := range []string{"workbuddy/galaxy-native-v2/connector-meta.json", "workbuddy/galaxy-native-v2/icon.svg", "codex/galaxy-native-v2/.codex-plugin/plugin.json", "INSTALL.md", "opencode/.agents/skills/galaxy/SKILL.md"} {
		if _, e := os.Stat(filepath.Join(input.Destination, filepath.FromSlash(path))); e != nil {
			t.Fatal("generated host asset missing", path, e)
		}
	}
	skillSource := filepath.Join(pkg, "skills", "galaxy")
	for _, target := range []string{"opencode/.agents/skills/galaxy", "claude-code/.claude/skills/galaxy", "codex/.agents/skills/galaxy", "copilot-vscode/.github/skills/galaxy", "copilot-cli/.copilot/skills/galaxy"} {
		if err := filepath.WalkDir(skillSource, func(path string, entry os.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			rel, err := filepath.Rel(skillSource, path)
			if err != nil {
				return err
			}
			expected, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			actual, err := os.ReadFile(filepath.Join(input.Destination, filepath.FromSlash(target), rel))
			if err != nil {
				return err
			}
			if string(expected) != string(actual) {
				t.Errorf("Skill module changed during host delivery: %s/%s", target, rel)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestHostConfigurationOriginalDefaultHosts(t *testing.T) {
	pkg := installationFixturePackage(t)
	root := t.TempDir()
	config := filepath.Join(root, "public.json")
	if e := os.WriteFile(config, []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	result, e := GenerateHostConfigurations(context.Background(), HostConfigurationInput{PackageDirectory: pkg, ConfigPath: config, Destination: filepath.Join(root, "generated")})
	if e != nil || result["hostCount"] != len(HostConfigurationOptions())-1 {
		t.Fatal(result, e)
	}
	if _, e = os.Stat(filepath.Join(root, "generated", "opencode")); !os.IsNotExist(e) {
		t.Fatal("default implicitly chose OpenCode")
	}
	for _, host := range []struct{ path, key, skill string }{
		{"copilot-vscode/.vscode/mcp.json", "servers", "copilot-vscode/.github/skills/galaxy/SKILL.md"},
		{"copilot-cli/mcp-config.json", "mcpServers", "copilot-cli/.copilot/skills/galaxy/SKILL.md"},
	} {
		var value map[string]any
		if present, err := readJSON(filepath.Join(root, "generated", filepath.FromSlash(host.path)), &value); err != nil || !present {
			t.Fatal("Copilot configuration missing", host.path, err)
		}
		spec := uploadObject(uploadObject(value[host.key])["galaxy"])
		if spec["command"] != filepath.Join(pkg, "galaxy.exe") || !connectionEqual(spec["args"], []string{"native"}) {
			t.Fatal("wrong Copilot command", host.path, spec)
		}
		if _, err := os.Stat(filepath.Join(root, "generated", filepath.FromSlash(host.skill))); err != nil {
			t.Fatal("Copilot Skill missing", host.skill, err)
		}
	}
}

func TestHostConfigurationJSONCPreservesOtherSettingsAndRejectsChangedReview(t *testing.T) {
	ctx := context.Background()
	pkg := installationFixturePackage(t)
	root := t.TempDir()
	directory := filepath.Join(root, "profile")
	if e := os.Mkdir(directory, 0700); e != nil {
		t.Fatal(e)
	}
	original := "// 保留模型与注释\n{\"provider\":{\"unchanged\":\"synthetic-provider\"},\"mcp\":{\"other\":{\"type\":\"local\",\"command\":[\"other\"]}},\"skills\":{\"paths\":[\"other-skills\"]},}\n"
	tui := "/* retained */\n{\"theme\":\"original\",\"plugin\":[\"unrelated\",[\"configured\",{\"keep\":true}]],}\n"
	if e := os.WriteFile(filepath.Join(directory, "opencode.jsonc"), []byte(original), 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(directory, "tui.json"), []byte(tui), 0600); e != nil {
		t.Fatal(e)
	}
	input := HostConfigurationInput{PackageDirectory: pkg, ConfigPath: filepath.Join(root, "config.json"), DataDirectory: filepath.Join(root, "data"), Endpoint: "https://api.configuration.invalid"}
	plan, e := PreviewOpenCodeConfiguration(ctx, directory, input)
	if e != nil {
		t.Fatal(e)
	}
	raw, _ := os.ReadFile(filepath.Join(directory, "opencode.jsonc"))
	if string(raw) != original {
		t.Fatal("preview mutated profile")
	}
	if _, e = InstallOpenCodeConfigurationReviewed(ctx, plan, false); e == nil {
		t.Fatal("unconfirmed install accepted")
	}
	if _, e = InstallOpenCodeConfigurationReviewed(ctx, plan, true); e != nil {
		t.Fatal(e)
	}
	raw, e = os.ReadFile(filepath.Join(directory, "opencode.jsonc"))
	if e != nil || !strings.Contains(string(raw), "// 保留模型与注释") || !strings.Contains(string(raw), `"provider":{"unchanged":"synthetic-provider"}`) {
		t.Fatal("unrelated profile bytes changed", e, string(raw))
	}
	value, e := hostConfigurationObject(string(raw))
	if e != nil {
		t.Fatal(e)
	}
	if uploadObject(uploadObject(value["mcp"])["other"])["type"] != "local" {
		t.Fatal("other MCP lost")
	}
	raw, e = os.ReadFile(filepath.Join(directory, "tui.json"))
	if e != nil {
		t.Fatal(e)
	}
	value, e = hostConfigurationObject(string(raw))
	if e != nil || len(uploadRows(value["plugin"])) != 3 || !strings.Contains(string(raw), "/* retained */") {
		t.Fatal("plugin preservation failed", e)
	}
	plan, e = PreviewOpenCodeConfiguration(ctx, directory, input)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = InstallOpenCodeConfigurationReviewed(ctx, plan, true); e != nil {
		t.Fatal(e)
	}
	raw, _ = os.ReadFile(filepath.Join(directory, "tui.json"))
	value, _ = hostConfigurationObject(string(raw))
	if len(uploadRows(value["plugin"])) != 3 {
		t.Fatal("Galaxy plugin duplicated")
	}
	plan, e = PreviewOpenCodeConfiguration(ctx, directory, input)
	if e != nil {
		t.Fatal(e)
	}
	changed := string(raw) + "// concurrent edit\n"
	if e = os.WriteFile(filepath.Join(directory, "tui.json"), []byte(changed), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = InstallOpenCodeConfigurationReviewed(ctx, plan, true); e == nil {
		t.Fatal("concurrent profile overwritten")
	}
	after, _ := os.ReadFile(filepath.Join(directory, "tui.json"))
	if string(after) != changed {
		t.Fatal("concurrent edit lost")
	}
	for _, invalid := range []string{"/*", `{"a":1} garbage`, `[]`, `{"a":`, "{\"a\":\"unterminated}"} {
		if _, e = hostConfigurationObject(invalid); e == nil {
			t.Fatal("invalid JSONC accepted", invalid)
		}
	}
}
func TestInstallationPreviewServiceConfiguration(t *testing.T) {
	ctx := context.Background()
	pkg := installationFixturePackage(t)
	root := t.TempDir()
	public, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	pem, e := identity.PublicPEM(public)
	if e != nil {
		t.Fatal(e)
	}
	now := time.Unix(2000000000, 0)
	source := map[string]any{"version": 1, "endpoint": "https://api.configuration.invalid", "signingKeys": []any{map[string]any{"kid": "fixture", "publicKeyPem": pem, "notBefore": now.Unix() - 1, "notAfter": now.Unix() + 3600, "revoked": false}}}
	transport := &serviceConfigurationTransport{raw: hostJSONString(source)}
	input := NativeInstallationInput{Website: "https://configuration.invalid/some-page", Host: "opencode", DataDirectory: filepath.Join(root, "data"), Destination: filepath.Join(root, "installation"), PackageDirectory: pkg, OpenCodeConfigDirectory: filepath.Join(root, "opencode")}
	input.DefaultOpenCodeConfigDirectory = input.OpenCodeConfigDirectory
	plan, e := PreviewNativeInstallation(ctx, input, ServiceConfigurationOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return now }})
	if e != nil {
		t.Fatal(e)
	}
	if plan.Endpoint != "https://api.configuration.invalid" || !plan.NormalStartupConfigured || transport.requests != 1 {
		t.Fatal(plan, transport.requests)
	}
	for _, path := range []string{input.DataDirectory, input.Destination, input.OpenCodeConfigDirectory} {
		if _, e = os.Stat(path); !os.IsNotExist(e) {
			t.Fatal("preview created data", path, e)
		}
	}
}

func TestInstallationHoistedThinHostDependenciesAndOriginalScope(t *testing.T) {
	pkg := installationFixturePackage(t)
	parent := filepath.Dir(pkg)
	for _, name := range []string{"thin-host", "helper"} {
		directory := filepath.Join(parent, "node_modules", name)
		if e := os.MkdirAll(directory, 0700); e != nil {
			t.Fatal(e)
		}
		manifest := map[string]any{"name": name, "version": "1.0.0"}
		if name == "thin-host" {
			manifest["dependencies"] = map[string]string{"helper": "^1"}
			manifest["optionalDependencies"] = map[string]string{"optional-missing": "*"}
		}
		if e := writeJSON(filepath.Join(directory, "package.json"), manifest); e != nil {
			t.Fatal(e)
		}
	}
	if e := writeJSON(filepath.Join(pkg, "package.json"), map[string]any{"name": "candidate", "dependencies": map[string]string{"thin-host": "1.0.0"}}); e != nil {
		t.Fatal(e)
	}
	target := filepath.Join(t.TempDir(), "host")
	if e := hostCopyTree(pkg, target); e != nil {
		t.Fatal(e)
	}
	if e := installationCaptureDependencies(pkg, target); e != nil {
		t.Fatal(e)
	}
	for _, path := range []string{"node_modules/thin-host/package.json", "node_modules/thin-host/node_modules/helper/package.json"} {
		if e := hostFile(filepath.Join(target, filepath.FromSlash(path))); e != nil {
			t.Fatal("thin graph not captured", path, e)
		}
	}
	ctx := context.Background()
	store, e := NewStore(filepath.Join(t.TempDir(), "data"), "https://api.configuration.invalid")
	if e != nil {
		t.Fatal(e)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.InitializeLocalIdentity(ctx, "person", true, &scope); e != nil {
		t.Fatal(e)
	}
	if e = store.With(ctx, false, func(dir string) error { return store.verifyChoiceWithin(dir, &scope) }); e == nil {
		t.Fatal("old parent choice accepted")
	}
	normal, e := OpenCodeConfigurationDirectory(map[string]string{"OPENCODE_CONFIG_DIR": filepath.Join(parent, "explicit")}, parent)
	if e != nil || normal != filepath.Join(parent, "explicit") {
		t.Fatal(normal, e)
	}
}

func TestCodexManagedTablesPreserveSubsequentUserTables(t *testing.T) {
	pkg := installationFixturePackage(t)
	path := filepath.Join(t.TempDir(), "config.toml")
	input := HostConfigurationInput{PackageDirectory: pkg, LocalOnly: true, DataDirectory: filepath.Join(t.TempDir(), "data")}
	block, err := UpdateCodexNativeConfiguration(path, input, "")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	other := "\n[unrelated.settings]\nvalue = \"keep\"\n\n[hooks.state.example]\ntrusted_hash = \"keep\"\n"
	modified := strings.Replace(string(raw), codexGalaxyEnd, other+codexGalaxyEnd, 1)
	if err := os.WriteFile(path, []byte(modified), 0600); err != nil {
		t.Fatal(err)
	}
	record := &managedNativeRecord{Host: "codex", HostConfigPath: path, CodexBlock: block, ReleaseDirectory: pkg, SkillPath: filepath.Join(pkg, "skills", "galaxy")}
	if matches, err := managedNativeStateMatches(record); err != nil || !matches {
		t.Fatalf("recovery did not recognize the managed tables: %v, %v", matches, err)
	}
	newBlock, err := UpdateCodexNativeConfiguration(path, input, block)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), other) {
		t.Fatalf("repair changed unrelated tables: %v", err)
	}
	if err := RemoveCodexNativeConfiguration(path, newBlock); err != nil {
		t.Fatal(err)
	}
	raw, err = os.ReadFile(path)
	if err != nil || !strings.Contains(string(raw), other) || strings.Contains(string(raw), "[mcp_servers.galaxy]") {
		t.Fatalf("uninstall did not preserve unrelated tables: %v", err)
	}

	for _, change := range []struct{ name, text string }{
		{"command", strings.Replace(block, "command = ", "command = \"user-change\" # ", 1)},
		{"additional field", strings.Replace(block, codexGalaxyEnd, "enabled = false\n"+codexGalaxyEnd, 1)},
	} {
		t.Run(change.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(change.text), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := UpdateCodexNativeConfiguration(path, input, block); err == nil {
				t.Fatal("repair accepted a changed Galaxy table")
			}
			if err := RemoveCodexNativeConfiguration(path, block); err == nil {
				t.Fatal("uninstall accepted a changed Galaxy table")
			}
			if matches, err := managedNativeStateMatches(record); err != nil || matches {
				t.Fatalf("recovery accepted a changed Galaxy table: %v, %v", matches, err)
			}
		})
	}
}

func TestOpenCodeV2ManagedMigrationPreservesUserSettings(t *testing.T) {
	ctx := context.Background()
	pkg := installationFixturePackage(t)
	dir := filepath.Join(t.TempDir(), "config")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	input := HostConfigurationInput{LocalOnly: true, PackageDirectory: pkg, DataDirectory: filepath.Join(t.TempDir(), "data"), OpenCodeLayout: "v1"}
	first, err := PreviewOpenCodeConfiguration(ctx, dir, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = InstallOpenCodeConfigurationReviewed(ctx, first, true); err != nil {
		t.Fatal(err)
	}
	legacyPath := filepath.Join(dir, "opencode.json")
	legacyRaw, err := os.ReadFile(legacyPath)
	if err != nil {
		t.Fatal(err)
	}
	disabledLegacy, err := hostSetConfiguration(string(legacyRaw), []string{"mcp", "galaxy", "enabled"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(legacyPath, []byte(disabledLegacy), 0600); err != nil {
		t.Fatal(err)
	}
	args, env := input.launch()
	prior := map[string]any{"type": "local", "command": append([]string{hostExecutable(pkg)}, args...), "environment": env, "enabled": true}
	// Match real decoded JSON values, as the installation record does.
	raw, err := hostJSON(prior)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err = json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	cli := `{"plugins":["other.plugin","-galaxy.opencode.stable.tui"],"theme":{"name":"dark"}}`
	if err = os.WriteFile(filepath.Join(dir, "cli.json"), []byte(cli), 0600); err != nil {
		t.Fatal(err)
	}
	input.OpenCodeLayout = "v2"
	input.OpenCodePriorSpec = decoded
	input.OpenCodePriorLayout = "v1"
	plan, err := PreviewOpenCodeConfiguration(ctx, dir, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = InstallOpenCodeConfigurationReviewed(ctx, plan, true); err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if _, err = readJSON(filepath.Join(dir, "opencode.json"), &config); err != nil {
		t.Fatal(err)
	}
	mcp := uploadObject(config["mcp"])
	if _, ok := mcp["galaxy"]; ok {
		t.Fatal("legacy managed entry remains")
	}
	if uploadObject(mcp["servers"])["galaxy"] == nil {
		t.Fatal("v2 server missing")
	}
	if uploadObject(uploadObject(mcp["servers"])["galaxy"])["disabled"] != true {
		t.Fatal("disabled choice was lost")
	}
	var cliConfig map[string]any
	if _, err = readJSON(filepath.Join(dir, "cli.json"), &cliConfig); err != nil {
		t.Fatal(err)
	}
	plugins := cliConfig["plugins"].([]any)
	if len(plugins) != 2 || plugins[0] != "other.plugin" || plugins[1] != "-galaxy.opencode.stable.tui" {
		t.Fatal(plugins)
	}
	globalPlugins, ok := config["plugins"].([]any)
	if !ok || len(globalPlugins) != 1 || globalPlugins[0] != hostFileURL(filepath.Join(dir, "galaxy-native")) {
		t.Fatal("server plugin not registered globally", config["plugins"])
	}
	if uploadObject(cliConfig["theme"])["name"] != "dark" {
		t.Fatal("theme changed")
	}
	if _, err = os.Stat(filepath.Join(dir, "galaxy-native", "package.json")); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "galaxy-native", "server.js")); err != nil || string(raw) != hostOpenCodeV2ServerPlugin(input) {
		t.Fatal("server entry missing", err)
	}
	// Existing 0.1.12 V2 installs had only a TUI export in cli.json. Repair
	// must migrate the same owned package while preserving unrelated entries.
	manifestPath := filepath.Join(dir, "galaxy-native", "package.json")
	if err = os.WriteFile(manifestPath, []byte(hostOpenCodeV2LegacyManifest), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(dir, "galaxy-native", "server.js")); err != nil {
		t.Fatal(err)
	}
	oldGlobal, err := hostRemoveConfiguration(string(mustReadHostTest(t, filepath.Join(dir, "opencode.json"))), []string{"plugins"})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "opencode.json"), []byte(oldGlobal), 0600); err != nil {
		t.Fatal(err)
	}
	legacyCLI := `{"plugins":["other.plugin",` + hostJSONString(hostFileURL(filepath.Join(dir, "galaxy-native"))) + `]}`
	if err = os.WriteFile(filepath.Join(dir, "cli.json"), []byte(legacyCLI), 0600); err != nil {
		t.Fatal(err)
	}
	input.OpenCodePriorLayout = "v2"
	plan, err = PreviewOpenCodeConfiguration(ctx, dir, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = InstallOpenCodeConfigurationReviewed(ctx, plan, true); err != nil {
		t.Fatal(err)
	}
	var migrated, migratedCLI map[string]any
	if _, err = readJSON(filepath.Join(dir, "opencode.json"), &migrated); err != nil {
		t.Fatal(err)
	}
	if _, err = readJSON(filepath.Join(dir, "cli.json"), &migratedCLI); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(migratedCLI["plugins"], []any{"other.plugin"}) {
		t.Fatal(migratedCLI)
	}
	if !reflect.DeepEqual(migrated["plugins"], []any{hostFileURL(filepath.Join(dir, "galaxy-native"))}) {
		t.Fatal(migrated)
	}
}

func mustReadHostTest(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
