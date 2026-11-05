package native

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

func managedOpenCodeSpec(record *managedNativeRecord) (any, error) {
	if record == nil {
		return nil, nil
	}
	input := HostConfigurationInput{LocalOnly: record.LocalOnly, PackageDirectory: record.ReleaseDirectory, ConfigPath: record.ConfigPath, DataDirectory: record.DataDirectory, Endpoint: record.Endpoint}
	entry, err := hostCandidate(record.ReleaseDirectory)
	if err != nil {
		return nil, err
	}
	args, env := input.launch()
	specification := map[string]any{"type": "local", "command": append([]string{entry}, args...), "environment": env}
	if record.OpenCodeLayout != "v2" {
		specification["enabled"] = true
	}
	raw, err := json.Marshal(specification)
	if err != nil {
		return nil, err
	}
	var spec any
	err = json.Unmarshal(raw, &spec)
	return spec, err
}
func managedOpenCodeSpecMatches(value, expected any) bool {
	if expected == nil {
		return false
	}
	a, aok := value.(map[string]any)
	b, bok := expected.(map[string]any)
	if !aok || !bok {
		return reflect.DeepEqual(value, expected)
	}
	// Enabled/disabled is the user's setting; retain it while matching ownership.
	for _, key := range []string{"type", "command", "environment"} {
		if !reflect.DeepEqual(a[key], b[key]) {
			return false
		}
	}
	return true
}
func managedOpenCodeCheck(directory string, prior *managedNativeRecord) error {
	expected, err := managedOpenCodeSpec(prior)
	if err != nil {
		return err
	}
	files, err := hostSelectedConfigurations(directory, "opencode")
	if err != nil {
		return err
	}
	for _, file := range files {
		if file.missing {
			continue
		}
		obj, e := hostConfigurationObject(file.text)
		if e != nil {
			return e
		}
		mcp := uploadObject(obj["mcp"])
		for _, existing := range []any{mcp["galaxy"], uploadObject(mcp["servers"])["galaxy"]} {
			if existing != nil && !managedOpenCodeSpecMatches(existing, expected) {
				return hostConfigurationFailure("setup_host_config_conflict")
			}
		}
	}
	plugin := filepath.Join(directory, "galaxy-native.tui.mjs")
	if prior != nil && prior.OpenCodeLayout == "v2" {
		plugin = filepath.Join(directory, "galaxy-native", "tui.js")
	}
	raw, err := os.ReadFile(plugin)
	if err == nil {
		if prior == nil {
			return hostConfigurationFailure("setup_host_config_conflict")
		}
		old := HostConfigurationInput{LocalOnly: prior.LocalOnly, PackageDirectory: prior.ReleaseDirectory, ConfigPath: prior.ConfigPath, DataDirectory: prior.DataDirectory, Endpoint: prior.Endpoint}
		expectedPlugin := hostOpenCodePlugin(old)
		if prior.OpenCodeLayout == "v2" {
			expectedPlugin = hostOpenCodeV2Plugin(old)
		}
		if string(raw) != expectedPlugin {
			return hostConfigurationFailure("setup_host_config_changed")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	serverPath := filepath.Join(directory, "galaxy-native", "server.js")
	if raw, err := os.ReadFile(serverPath); err == nil {
		if prior == nil || prior.OpenCodeLayout != "v2" {
			return hostConfigurationFailure("setup_host_config_conflict")
		}
		old := HostConfigurationInput{PackageDirectory: prior.ReleaseDirectory, ConfigPath: prior.ConfigPath, DataDirectory: prior.DataDirectory}
		if err = hostFile(serverPath); err != nil {
			return err
		}
		if string(raw) != hostOpenCodeV2ServerPlugin(old) {
			return hostConfigurationFailure("setup_host_config_changed")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	return nil
}
func managedOpenCodeRemove(ctx context.Context, record *managedNativeRecord) error {
	if err := managedOpenCodeCheck(record.HostConfigPath, record); err != nil {
		return err
	}
	oldSkill := filepath.Join(record.ReleaseDirectory, "skills")
	plugin := filepath.Join(record.HostConfigPath, "galaxy-native.tui.mjs")
	pluginURL := hostFileURL(plugin)
	names := []string{"opencode", "tui"}
	if record.OpenCodeLayout == "v2" {
		plugin = filepath.Join(record.HostConfigPath, "galaxy-native", "tui.js")
		pluginURL = hostFileURL(filepath.Dir(plugin))
		names = []string{"opencode", "cli"}
	}
	if record.OpenCodeLayout == "v2" {
		manifestPath := filepath.Join(filepath.Dir(plugin), "package.json")
		if raw, err := os.ReadFile(manifestPath); err == nil && string(raw) != hostOpenCodeV2Manifest && string(raw) != hostOpenCodeV2LegacyManifest {
			return hostConfigurationFailure("setup_host_config_changed")
		} else if err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	for _, name := range names {
		files, err := hostSelectedConfigurations(record.HostConfigPath, name)
		if err != nil {
			return err
		}
		for _, file := range files {
			if name == "cli" && filepath.Ext(file.path) != ".json" {
				continue
			}
			if file.missing {
				continue
			}
			if err = ctx.Err(); err != nil {
				return err
			}
			obj, e := hostConfigurationObject(file.text)
			if e != nil {
				return e
			}
			updated := file.text
			if name == "opencode" {
				mcpPath := []string{"mcp", "galaxy"}
				entry := uploadObject(obj["mcp"])["galaxy"]
				if record.OpenCodeLayout == "v2" {
					mcpPath = []string{"mcp", "servers", "galaxy"}
					entry = uploadObject(uploadObject(obj["mcp"])["servers"])["galaxy"]
				}
				if managedOpenCodeSpecMatches(entry, record.ManagedSpec) {
					updated, e = hostRemoveConfiguration(updated, mcpPath)
					if e != nil {
						return e
					}
				}
				paths := uploadObject(obj["skills"])["paths"]
				if list, ok := paths.([]any); ok {
					next := []any{}
					for _, x := range list {
						if x != oldSkill {
							next = append(next, x)
						}
					}
					updated, e = hostSetConfiguration(updated, []string{"skills", "paths"}, next)
					if e != nil {
						return e
					}
				}
				if record.OpenCodeLayout == "v2" {
					if list, ok := obj["plugins"].([]any); ok {
						next := []any{}
						for _, x := range list {
							own := ""
							if v, ok := x.(string); ok {
								own = v
							} else if v, ok := x.([]any); ok && len(v) > 0 {
								own = text(v[0])
							} else if v, ok := x.(map[string]any); ok {
								own = text(v["package"])
							}
							if own != pluginURL {
								next = append(next, x)
							}
						}
						updated, e = hostSetConfiguration(updated, []string{"plugins"}, next)
						if e != nil {
							return e
						}
					}
				}
			} else if list, ok := obj[map[bool]string{true: "plugins", false: "plugin"}[name == "cli"]].([]any); ok {
				next := []any{}
				for _, x := range list {
					own := ""
					if s, ok := x.(string); ok {
						own = s
					} else if tuple, ok := x.([]any); ok && len(tuple) > 0 {
						own = text(tuple[0])
					} else if object, ok := x.(map[string]any); ok {
						own = text(object["package"])
					}
					if own != pluginURL {
						next = append(next, x)
					}
				}
				key := "plugin"
				if name == "cli" {
					key = "plugins"
				}
				updated, e = hostSetConfiguration(updated, []string{key}, next)
				if e != nil {
					return e
				}
			}
			if updated != file.text {
				if e = hostReplaceSelected(file.path, updated, &file.previous); e != nil {
					return e
				}
			}
		}
	}
	if err := os.Remove(plugin); err != nil && !os.IsNotExist(err) {
		return err
	}
	if record.OpenCodeLayout == "v2" {
		if err := os.Remove(filepath.Join(filepath.Dir(plugin), "server.js")); err != nil && !os.IsNotExist(err) {
			return err
		}
		manifestPath := filepath.Join(filepath.Dir(plugin), "package.json")
		if err := os.Remove(manifestPath); err != nil && !os.IsNotExist(err) {
			return err
		}
		if err := os.Remove(filepath.Dir(plugin)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	metadata := filepath.Join(record.HostConfigPath, "galaxy-installation.json")
	var saved map[string]any
	present, err := readJSON(metadata, &saved)
	if err != nil {
		return err
	}
	if present {
		if text(saved["plugin"]) != pluginURL || text(saved["skillPath"]) != oldSkill {
			return hostConfigurationFailure("setup_host_config_changed")
		}
		if err = os.Remove(metadata); err != nil {
			return err
		}
	}
	return nil
}

// UninstallManagedNativeHost removes only the named host's managed integration.
// Immutable releases and application data are retained for other sessions and
// recovery; no daemon is killed and no other host is changed.
func UninstallManagedNativeHost(ctx context.Context, installRoot, host string) (map[string]any, error) {
	return UninstallManagedNativeHostAt(ctx, installRoot, host, "")
}

// UninstallManagedNativeHostAt selects a particular user configuration when
// a host has multiple profiles; empty configPath selects the legacy record.
func UninstallManagedNativeHostAt(ctx context.Context, installRoot, host, configPath string) (map[string]any, error) {
	recordPath, err := managedRecordPath(installRoot, host, configPath)
	if err != nil {
		return nil, err
	}
	if _, e := os.Lstat(recordPath + ".pending"); e == nil {
		if e = recoverManagedNativeInstallation(recordPath); e != nil {
			return map[string]any{"recoveryJournal": recordPath + ".pending"}, e
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	var record managedNativeRecord
	present, err := readJSON(recordPath, &record)
	if err != nil {
		return nil, err
	}
	if !present || record.Version != 1 || record.Host != host {
		return nil, hostConfigurationFailure("setup_installation_missing")
	}
	if err = hostFile(recordPath); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(recordPath)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"host": host, "hostConfigured": true, "dataPreserved": true, "releasesRetained": true}
	retainSkill, err := managedSkillReferenced(installRoot, filepath.Base(recordPath), record.SkillPath)
	if err != nil {
		return result, err
	}
	result["skillRetained"] = retainSkill
	if host == "codex" && len(record.CodexHookTrust) > 0 {
		remaining, cleanupErr := clearCodexHookTrust(ctx, record.HostExecutable, &record)
		if cleanupErr != nil || len(remaining) > 0 {
			result["hookTrustCleanup"] = "retained"
		} else {
			result["hookTrustCleanup"] = "removed"
		}
	}
	for _, group := range []any{record.HookGroup, record.HookPrevious} {
		if group != nil {
			if err = removeManagedHooks(host, record.HookPath, group); err != nil {
				return result, err
			}
		}
	}
	result["hooksRemoved"] = true
	adapter := managedRecordAdapter(&record)
	switch adapter {
	case "opencode":
		err = managedOpenCodeRemove(ctx, &record)
	case "claude-code", "cursor", "github-copilot", "github-copilot-cli", "custom-json-mcpServers", "custom-json-servers":
		_, err = RemoveUserHostConfiguration(ctx, adapter, record.HostConfigPath, record.SkillPath, filepath.Join(record.ReleaseDirectory, "skills", "galaxy"), record.ManagedSpec, retainSkill)
	case "deepseek-harness":
		spec, _ := record.ManagedSpec.(map[string]any)
		if spec == nil {
			return result, hostConfigurationFailure("setup_host_config_changed")
		}
		_, e := os.Lstat(record.SkillPath)
		missing := os.IsNotExist(e)
		if e != nil && !missing {
			return result, e
		}
		if !missing && !retainSkill {
			same, e := installationSkillEqual(record.SkillPath, filepath.Join(record.ReleaseDirectory, "skills", "galaxy"))
			if e != nil {
				return result, e
			}
			if !same {
				return result, hostConfigurationFailure("setup_skill_conflict")
			}
		}
		err = dshPatch(record.HostConfigPath, spec, spec, true)
		if err == nil && !missing && !retainSkill {
			err = os.RemoveAll(record.SkillPath)
		}
	case "hermes":
		spec, _ := record.ManagedSpec.(map[string]any)
		if spec == nil {
			return result, hostConfigurationFailure("setup_host_config_changed")
		}
		paths := []struct{ target, source string }{{record.SkillPath, filepath.Join(record.ReleaseDirectory, "skills", "galaxy")}, {record.ManagedPluginPath, filepath.Join(record.ReleaseDirectory, "host-adapters", "hermes")}}
		for _, item := range paths {
			if retainSkill && item.target == record.SkillPath {
				continue
			}
			if !filepath.IsAbs(item.target) {
				return result, hostConfigurationFailure("setup_path_invalid")
			}
			_, e := os.Lstat(item.target)
			if os.IsNotExist(e) {
				continue
			}
			if e != nil {
				return result, e
			}
			same, e := installationSkillEqual(item.target, item.source)
			if item.target == record.ManagedPluginPath {
				same, e = installationHermesEqual(item.target, item.source)
			}
			if e != nil {
				return result, e
			}
			if !same {
				return result, hostConfigurationFailure("setup_skill_conflict")
			}
		}
		err = hermesConfiguration(record.HostConfigPath, spec, spec, true)
		if err == nil {
			for _, item := range paths {
				if retainSkill && item.target == record.SkillPath {
					continue
				}
				if e := os.RemoveAll(item.target); e != nil {
					err = e
					break
				}
			}
		}
	case "codex", "custom-toml":
		_, statErr := os.Lstat(record.SkillPath)
		skillMissing := os.IsNotExist(statErr)
		if statErr != nil && !skillMissing {
			err = statErr
		}
		if err == nil && !skillMissing && !retainSkill {
			var same bool
			same, err = installationSkillEqual(record.SkillPath, filepath.Join(record.ReleaseDirectory, "skills", "galaxy"))
			if err == nil && !same {
				err = hostConfigurationFailure("setup_skill_conflict")
			}
		}
		if err == nil {
			err = RemoveCodexNativeConfiguration(record.HostConfigPath, record.CodexBlock)
		}
		if err == nil && !skillMissing && !retainSkill {
			err = os.RemoveAll(record.SkillPath)
		}
	}
	if err != nil {
		return result, err
	}
	result["hostConfigured"] = false
	current, err := os.ReadFile(recordPath)
	if err != nil || string(current) != string(raw) {
		return result, hostConfigurationFailure("setup_host_config_changed")
	}
	if err = os.Remove(recordPath); err != nil {
		return result, err
	}
	return result, nil
}

// Never remove a shared skill referenced by another managed host or by a
// pending installation. Records are read locally and never exposed.
func managedSkillReferenced(root, host, skill string) (bool, error) {
	if skill == "" {
		return false, nil
	}
	dir := filepath.Join(root, "hosts")
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if strings.HasSuffix(name, ".pending") {
			return true, nil
		}
		if !strings.HasSuffix(name, ".json") || name == host {
			continue
		}
		var r managedNativeRecord
		ok, err := readJSON(filepath.Join(dir, name), &r)
		if err != nil || !ok {
			return false, hostConfigurationFailure("setup_host_config_conflict")
		}
		if installationSamePath(r.SkillPath, skill) {
			return true, nil
		}
	}
	return false, nil
}
