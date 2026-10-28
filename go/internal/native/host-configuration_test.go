package native

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"net/http"
	"os"
	"path/filepath"
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
	for name, value := range map[string]string{"galaxy.exe": "synthetic binary fixture", "galaxy": "synthetic binary fixture", "galaxy.js": "// original fixture only", "opencode.js": "export function createNativeGalaxyPlugin(options){return options}", "HOSTS.md": "Original-format isolated host instructions", "host-capabilities.json": string(matrix), "package.json": `{"name":"isolated-candidate","dependencies":{}}`} {
		if e = os.WriteFile(filepath.Join(dir, name), []byte(value), 0700); e != nil {
			t.Fatal(e)
		}
	}
	if e = writeJSON(filepath.Join(dir, "native-v2.json"), map[string]any{"kind": "galaxy-native-go-local-candidate", "backend": "go", "mcp": map[string]any{"command": "galaxy.exe", "args": []string{"native"}}}); e != nil {
		t.Fatal(e)
	}
	return dir
}
func TestHostConfigurationNineFormatsAndOriginalAssets(t *testing.T) {
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
	if result["hostCount"] != 9 || result["actualSettingsModified"] != false {
		t.Fatal(result)
	}
	paths := []string{"claude-code/.mcp.json", "claude-desktop-chat/claude_desktop_config.fragment.json", "cursor/.cursor/mcp.json", "workbuddy/galaxy-native-v2/mcp.json", "trae-work/mcp.local.json", "codex/galaxy-native-v2/.mcp.json"}
	for _, path := range paths {
		var value map[string]any
		if _, e = readJSON(filepath.Join(input.Destination, filepath.FromSlash(path)), &value); e != nil {
			t.Fatal(e)
		}
		spec := uploadObject(uploadObject(value["mcpServers"])["galaxy"])
		if spec["command"] != filepath.Join(pkg, "galaxy.exe") || !connectionEqual(spec["args"], []string{"native"}) {
			t.Fatal("wrong Go command", path, spec)
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
	// Original JS retains the same asset formats; it runs only against this
	// disposable source package with an explicitly synthetic old entry.
	if e = writeJSON(filepath.Join(pkg, "native-v2.json"), map[string]any{"kind": "galaxy-native-v2-local-candidate"}); e != nil {
		t.Fatal(e)
	}
	oldDestination := filepath.Join(root, "original")
	initializationNode(t, `import {generateHostConfigs} from './integrations/native-v2/host-configs.mjs';console.log(JSON.stringify(await generateHostConfigs({packageDirectory:process.argv[1],configPath:process.argv[2],destination:process.argv[3],hosts:['opencode','claude-code','github-copilot','codex','cursor','workbuddy','trae-desktop','hermes','deepseek-harness'],dataDirectory:process.argv[4],endpoint:'https://api.configuration.invalid'})));`, pkg, config, oldDestination, input.DataDirectory)
	for _, path := range []string{"workbuddy/galaxy-native-v2/connector-meta.json", "workbuddy/galaxy-native-v2/icon.svg", "codex/galaxy-native-v2/.codex-plugin/plugin.json", "INSTALL.md", "opencode/.agents/skills/galaxy/SKILL.md"} {
		got, e := os.ReadFile(filepath.Join(input.Destination, filepath.FromSlash(path)))
		if e != nil {
			t.Fatal(e)
		}
		original, e := os.ReadFile(filepath.Join(oldDestination, filepath.FromSlash(path)))
		if e != nil {
			t.Fatal(e)
		}
		if strings.HasSuffix(path, ".json") {
			var a, b any
			if protocolDecode(got, &a) != nil || protocolDecode(original, &b) != nil || !connectionEqual(a, b) {
				t.Fatal("original asset differs", path)
			}
		} else if string(got) != string(original) {
			t.Fatal("original asset differs", path)
		}
	}
}
func protocolDecode(raw []byte, value any) error { return protocol.Decode(raw, value) }

func TestHostConfigurationOriginalDefaultHosts(t *testing.T) {
	pkg := installationFixturePackage(t)
	root := t.TempDir()
	config := filepath.Join(root, "public.json")
	if e := os.WriteFile(config, []byte("{}"), 0600); e != nil {
		t.Fatal(e)
	}
	result, e := GenerateHostConfigurations(context.Background(), HostConfigurationInput{PackageDirectory: pkg, ConfigPath: config, Destination: filepath.Join(root, "generated")})
	if e != nil || result["hostCount"] != 8 {
		t.Fatal(result, e)
	}
	if _, e = os.Stat(filepath.Join(root, "generated", "opencode")); !os.IsNotExist(e) {
		t.Fatal("default implicitly chose OpenCode")
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
func TestInstallationDeclineAndActualTemporaryOpenCodePreparation(t *testing.T) {
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
	if result, e := PrepareNativeInstallationReviewed(ctx, plan, "", false); e != nil || result["canceled"] != true {
		t.Fatal(result, e)
	}
	for _, path := range []string{input.DataDirectory, input.Destination, input.OpenCodeConfigDirectory} {
		if _, e = os.Stat(path); !os.IsNotExist(e) {
			t.Fatal("preview or decline created data", path)
		}
	}
	result, e := PrepareNativeInstallationReviewed(ctx, plan, "organization", true)
	if e != nil {
		t.Fatal(e)
	}
	if result["prepared"] != true || result["identityCreated"] != true || result["connected"] != false || result["normalStartupConfigured"] != true || transport.requests != 1 {
		t.Fatal(result, transport.requests)
	}
	store, e := NewStore(input.DataDirectory, "https://api.configuration.invalid")
	if e != nil {
		t.Fatal(e)
	}
	snapshot, e := store.LocalSnapshot(ctx)
	if e != nil || uploadObject(snapshot["identity"])["subjectType"] != "organization" || uploadObject(uploadObject(snapshot["state"])["integration"])["modules"] == nil {
		t.Fatal("not prepared local work", e)
	}
	if _, e = os.Stat(filepath.Join(input.DataDirectory, "native-v2")); !os.IsNotExist(e) {
		t.Fatal("installation created Native binding")
	}
	plugin, e := os.ReadFile(filepath.Join(input.OpenCodeConfigDirectory, "galaxy-native.tui.mjs"))
	if e != nil || !strings.Contains(string(plugin), `"backend":"go"`) || strings.Contains(string(plugin), "galaxy.js") {
		t.Fatal("installed plugin uses old core", e)
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
	target, e := installationCopyPackage(pkg, filepath.Join(t.TempDir(), "host"))
	if e != nil {
		t.Fatal(e)
	}
	for _, path := range []string{"node_modules/thin-host/package.json", "node_modules/thin-host/node_modules/helper/package.json"} {
		if e = hostFile(filepath.Join(target, filepath.FromSlash(path))); e != nil {
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
	destination := filepath.Join(t.TempDir(), "pending-install")
	plan := &NativeInstallationPlan{input: NativeInstallationInput{DataDirectory: store.Directory, Destination: destination, PackageDirectory: pkg, SubjectType: "person"}, scope: scope, service: &ServiceConfigurationInspection{Endpoint: store.Endpoint}}
	if _, e = PrepareNativeInstallationReviewed(ctx, plan, "", true); e == nil {
		t.Fatal("old parent choice accepted")
	}
	if _, e = os.Stat(destination); !os.IsNotExist(e) {
		t.Fatal("old scope wrote install")
	}
	normal, e := OpenCodeConfigurationDirectory(map[string]string{"OPENCODE_CONFIG_DIR": filepath.Join(parent, "explicit")}, parent)
	if e != nil || normal != filepath.Join(parent, "explicit") {
		t.Fatal(normal, e)
	}
}
