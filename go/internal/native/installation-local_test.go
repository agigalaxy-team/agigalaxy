package native

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHostConfigurationLocalOnlyAllHosts(t *testing.T) {
	root, pkg := t.TempDir(), installationFixturePackage(t)
	hosts := []string{}
	for _, host := range HostConfigurationOptions() {
		hosts = append(hosts, host["id"])
	}
	input := HostConfigurationInput{LocalOnly: true, PackageDirectory: pkg, DataDirectory: filepath.Join(root, "data"), Destination: filepath.Join(root, "hosts"), Hosts: hosts}
	result, err := GenerateHostConfigurations(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if result["localOnly"] != true || result["hostCount"] != len(hosts) {
		t.Fatal(result)
	}
	for _, name := range []string{"claude-code/.mcp.json", "cursor/.cursor/mcp.json", "codex/galaxy-native-v2/.mcp.json", "workbuddy/galaxy-native-v2/mcp.json", "trae-work/mcp.local.json"} {
		var config map[string]any
		if _, err = readJSON(filepath.Join(input.Destination, filepath.FromSlash(name)), &config); err != nil {
			t.Fatal(err)
		}
		spec := uploadObject(uploadObject(config["mcpServers"])["galaxy"])
		args := uploadRows(spec["args"])
		if len(args) != 3 || args[0] != "integration-mcp" || args[1] != "--data-dir" || args[2] != input.DataDirectory || len(uploadObject(spec["env"])) != 0 {
			t.Fatal(name, spec)
		}
	}
	for _, name := range []string{"opencode/opencode.json", "copilot-vscode/.vscode/mcp.json", "codex/config.fragment.toml", "hermes/config.fragment.yaml", "deepseek-harness/mcp-plugin.fragment.json"} {
		raw, err := os.ReadFile(filepath.Join(input.Destination, filepath.FromSlash(name)))
		if err != nil || !strings.Contains(string(raw), "integration-mcp") || strings.Contains(string(raw), "GALAXY_NATIVE_CONFIG") {
			t.Fatal(name, string(raw), err)
		}
	}
	plugin, err := os.ReadFile(filepath.Join(input.Destination, "opencode", "galaxy.tui.mjs"))
	if err != nil || !strings.Contains(string(plugin), `"configPath":""`) {
		t.Fatal(string(plugin), err)
	}
	if _, err = os.Stat(input.DataDirectory); !os.IsNotExist(err) {
		t.Fatal("configuration generation created user data", err)
	}
}

func TestInstallationLocalOnlyPreservesIdentityAndCarriesRuntime(t *testing.T) {
	ctx, pkg, root := context.Background(), installationFixturePackage(t), t.TempDir()
	input := NativeInstallationInput{LocalOnly: true, Host: "opencode", PackageDirectory: pkg, DataDirectory: filepath.Join(root, "data"), Destination: filepath.Join(root, "install"), OpenCodeConfigDirectory: filepath.Join(root, "profile"), SubjectType: "organization"}
	plan, err := PreviewNativeInstallation(ctx, input, ServiceConfigurationOptions{})
	if err != nil || !plan.LocalOnly {
		t.Fatal(plan, err)
	}
	for _, name := range []string{input.DataDirectory, input.Destination, input.OpenCodeConfigDirectory} {
		if _, err = os.Stat(name); !os.IsNotExist(err) {
			t.Fatal("preview wrote files", name, err)
		}
	}
	first, err := PrepareNativeInstallationReviewed(ctx, plan, "", true)
	if err != nil || first["localOnly"] != true || first["connected"] != false || first["identityCreated"] != true || first["configPath"] != "" {
		t.Fatal(first, err)
	}
	store, _ := NewStore(input.DataDirectory, "")
	before, err := store.LocalSnapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	owner := uploadObject(before["identity"])["id"]
	var profile map[string]any
	if _, err = readJSON(filepath.Join(input.OpenCodeConfigDirectory, "opencode.json"), &profile); err != nil {
		t.Fatal(err)
	}
	if uploadRows(uploadObject(uploadObject(profile["mcp"])["galaxy"])["command"])[1] != "integration-mcp" {
		t.Fatal(profile)
	}
	// A later installation for another host keeps the selected store and its
	// existing identity, and points at a copied runtime rather than source files.
	input.Host, input.Destination = "codex", filepath.Join(root, "codex-install")
	plan, err = PreviewNativeInstallation(ctx, input, ServiceConfigurationOptions{})
	if err != nil {
		t.Fatal(err)
	}
	second, err := PrepareNativeInstallationReviewed(ctx, plan, "", true)
	if err != nil || second["packageDirectory"] == pkg {
		t.Fatal(second, err)
	}
	if err = hostFile(filepath.Join(text(second["packageDirectory"]), "galaxy.exe")); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(input.Destination, "galaxy-public-config.json")); !os.IsNotExist(err) {
		t.Fatal("local installation created a service configuration", err)
	}
	after, err := store.LocalSnapshot(ctx)
	if err != nil || uploadObject(after["identity"])["id"] != owner {
		t.Fatal("identity changed", err)
	}
}
