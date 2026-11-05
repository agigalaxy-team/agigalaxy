package native

import (
	"context"
	"github.com/google/uuid"
	"os"
	"path/filepath"
)

type hostSelectedFile struct {
	path, previous, text string
	missing              bool
}

func hostSelectedConfigurations(directory, basename string) ([]hostSelectedFile, error) {
	result := []hostSelectedFile{}
	for _, suffix := range []string{".json", ".jsonc"} {
		path := filepath.Join(directory, basename+suffix)
		e := hostFile(path)
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return nil, e
		}
		raw, e := os.ReadFile(path)
		if e != nil {
			return nil, e
		}
		result = append(result, hostSelectedFile{path: path, previous: string(raw), text: string(raw)})
	}
	if len(result) == 0 {
		result = append(result, hostSelectedFile{path: filepath.Join(directory, basename+".json"), previous: "{}\n", text: "{}\n", missing: true})
	}
	return result, nil
}
func hostReplaceSelected(path, text string, previous *string) error {
	if previous != nil {
		raw, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		if string(raw) != *previous {
			return hostConfigurationFailure("setup_opencode_config_changed")
		}
		if string(raw) == text {
			return nil
		}
	}
	temporary := path + ".galaxy-" + uuid.NewString() + ".tmp"
	if e := hostWriteNew(temporary, []byte(text)); e != nil {
		return e
	}
	defer os.Remove(temporary)
	return os.Rename(temporary, path)
}
func hostDirectory(path string) error {
	info, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return hostConfigurationFailure("setup_opencode_config_conflict")
	}
	return nil
}

type OpenCodeConfigurationPlan struct {
	Directory          string   `json:"directory"`
	Plugin             string   `json:"plugin"`
	SkillsPath         string   `json:"skillPath"`
	ConfigurationFiles []string `json:"configurationFiles"`
	input              HostConfigurationInput
	files              []hostSelectedFile
	metadata           string
	metadataExists     bool
	pluginPrevious     string
	pluginExists       bool
}

// PreviewOpenCodeConfiguration reads only the explicitly provided directory.
// No ambient HOME/profile discovery, process start or file creation occurs.
func PreviewOpenCodeConfiguration(ctx context.Context, directory string, input HostConfigurationInput) (*OpenCodeConfigurationPlan, error) {
	paths := []string{directory, input.PackageDirectory, input.DataDirectory}
	if !input.LocalOnly {
		paths = append(paths, input.ConfigPath)
	}
	for _, path := range paths {
		if !filepath.IsAbs(path) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
	}
	if input.LocalOnly && (input.ConfigPath != "" || input.Endpoint != "") || !input.LocalOnly && !serviceConfigurationOrigin(input.Endpoint) {
		return nil, hostConfigurationFailure("setup_path_invalid")
	}
	if _, e := hostCandidate(input.PackageDirectory); e != nil {
		return nil, e
	}
	if e := hostFile(filepath.Join(input.PackageDirectory, "opencode.js")); e != nil {
		return nil, e
	}
	if e := hostDirectory(directory); e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	if input.OpenCodeLayout == "" {
		input.OpenCodeLayout = "v1"
	}
	if input.OpenCodeLayout == "v2" {
		if err := hostFile(filepath.Join(input.PackageDirectory, "opencode-v2.js")); err != nil {
			return nil, err
		}
		if err := hostFile(filepath.Join(input.PackageDirectory, "opencode-v2-server.js")); err != nil {
			return nil, err
		}
	}
	pluginPath := filepath.Join(directory, "galaxy-native.tui.mjs")
	if input.OpenCodeLayout == "v2" {
		pluginPath = filepath.Join(directory, "galaxy-native", "tui.js")
	}
	plan := &OpenCodeConfigurationPlan{Directory: filepath.Clean(directory), Plugin: pluginPath, SkillsPath: filepath.Join(input.PackageDirectory, "skills"), input: input, ConfigurationFiles: []string{}}
	metadataPath := filepath.Join(directory, "galaxy-installation.json")
	var previous map[string]any
	present, e := readJSON(metadataPath, &previous)
	if e != nil {
		return nil, e
	}
	plan.metadataExists = present
	if present {
		if e = hostFile(metadataPath); e != nil {
			return nil, e
		}
		raw, e := os.ReadFile(metadataPath)
		if e != nil {
			return nil, e
		}
		plan.metadata = string(raw)
	}
	if raw, e := os.ReadFile(plan.Plugin); e == nil {
		if e = hostFile(plan.Plugin); e != nil {
			return nil, e
		}
		plan.pluginPrevious = string(raw)
		plan.pluginExists = true
		if input.OpenCodeLayout == "v2" && input.OpenCodePriorLayout != "v2" && plan.pluginPrevious != hostOpenCodeV2Plugin(input) || input.OpenCodeLayout == "v1" && input.OpenCodePriorLayout == "v2" && plan.pluginPrevious != hostOpenCodePlugin(input) {
			return nil, hostConfigurationFailure("setup_host_config_conflict")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	pluginURL := hostFileURL(plan.Plugin)
	if input.OpenCodeLayout == "v2" {
		pluginURL = hostFileURL(filepath.Dir(plan.Plugin))
	}
	if input.OpenCodeLayout == "v2" {
		manifest := filepath.Join(filepath.Dir(plan.Plugin), "package.json")
		f := hostSelectedFile{path: manifest, text: hostOpenCodeV2Manifest, missing: true}
		if raw, err := os.ReadFile(manifest); err == nil {
			if err = hostFile(manifest); err != nil {
				return nil, err
			}
			f.previous, f.missing = string(raw), false
			if f.previous != f.text && !(f.previous == hostOpenCodeV2LegacyManifest && present && input.OpenCodePriorLayout == "v2") {
				return nil, hostConfigurationFailure("setup_opencode_config_conflict")
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		plan.files = append(plan.files, f)
		serverPath := filepath.Join(filepath.Dir(plan.Plugin), "server.js")
		server := hostSelectedFile{path: serverPath, text: hostOpenCodeV2ServerPlugin(input), missing: true}
		if raw, err := os.ReadFile(serverPath); err == nil {
			if err = hostFile(serverPath); err != nil {
				return nil, err
			}
			server.previous, server.missing = string(raw), false
			prior := HostConfigurationInput{PackageDirectory: filepath.Dir(text(previous["skillPath"])), ConfigPath: text(previous["configPath"]), DataDirectory: text(previous["dataDirectory"])}
			if server.previous != server.text && (!present || input.OpenCodePriorLayout != "v2" || server.previous != hostOpenCodeV2ServerPlugin(prior)) {
				return nil, hostConfigurationFailure("setup_host_config_conflict")
			}
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		plan.files = append(plan.files, server)
	}
	oldPlugin := text(previous["plugin"])
	oldSkill := text(previous["skillPath"])
	entry := hostExecutable(input.PackageDirectory)
	basenames := []string{"opencode", "tui"}
	if input.OpenCodeLayout == "v1" && input.OpenCodePriorLayout == "v2" {
		basenames = []string{"opencode", "tui", "cli"}
	}
	if input.OpenCodeLayout == "v2" {
		basenames = []string{"opencode", "cli", "tui"}
	}
	for _, basename := range basenames {
		var files []hostSelectedFile
		var e error
		if basename != "cli" {
			files, e = hostSelectedConfigurations(directory, basename)
		}
		if basename == "cli" {
			files = nil
			path := filepath.Join(directory, "cli.json")
			raw, readErr := os.ReadFile(path)
			if readErr == nil {
				if e = hostFile(path); e == nil {
					files = []hostSelectedFile{{path: path, previous: string(raw), text: string(raw)}}
				}
			} else if os.IsNotExist(readErr) {
				files = []hostSelectedFile{{path: path, previous: "{}\n", text: "{}\n", missing: true}}
			} else {
				e = readErr
			}
		}
		if e != nil {
			return nil, e
		}
		for _, file := range files {
			if basename == "cli" && file.missing {
				continue
			}
			if basename == "tui" && input.OpenCodeLayout == "v2" && (file.missing || input.OpenCodePriorSpec == nil || input.OpenCodePriorLayout == "v2") {
				continue
			}
			config, e := hostConfigurationObject(file.text)
			if e != nil {
				return nil, e
			}
			if basename == "opencode" {
				paths := uploadObject(config["skills"])["paths"]
				if paths == nil {
					paths = []any{}
				}
				list, ok := paths.([]any)
				if !ok {
					return nil, hostConfigurationFailure("setup_opencode_config_conflict")
				}
				next := []any{}
				for _, item := range list {
					value, ok := item.(string)
					if !ok {
						return nil, hostConfigurationFailure("setup_opencode_config_conflict")
					}
					if value != plan.SkillsPath && value != oldSkill {
						next = append(next, value)
					}
				}
				next = append(next, plan.SkillsPath)
				args, environment := input.launch()
				command := append([]string{entry}, args...)
				mcpPath := []string{"mcp", "galaxy"}
				spec := map[string]any{"type": "local", "command": command, "environment": environment, "enabled": true}
				if input.OpenCodeLayout == "v1" && input.OpenCodePriorLayout == "v2" && input.OpenCodePriorSpec != nil {
					old := uploadObject(uploadObject(config["mcp"])["servers"])["galaxy"]
					if managedOpenCodeSpecMatches(old, input.OpenCodePriorSpec) {
						if uploadObject(old)["disabled"] == true {
							spec["enabled"] = false
						}
						file.text, e = hostRemoveConfiguration(file.text, []string{"mcp", "servers", "galaxy"})
						if e != nil {
							return nil, e
						}
					}
				}
				if input.OpenCodeLayout == "v2" {
					mcpPath = []string{"mcp", "servers", "galaxy"}
					delete(spec, "enabled")
					mcp := uploadObject(config["mcp"])
					old := mcp["galaxy"]
					current := uploadObject(mcp["servers"])["galaxy"]
					if old != nil && input.OpenCodePriorSpec != nil && managedOpenCodeSpecMatches(old, input.OpenCodePriorSpec) {
						if legacy := uploadObject(old); legacy["enabled"] == false {
							spec["disabled"] = true
						}
						file.text, e = hostRemoveConfiguration(file.text, []string{"mcp", "galaxy"})
						if e != nil {
							return nil, e
						}
					}
					if current != nil {
						if existing, ok := current.(map[string]any); ok {
							merged := map[string]any{}
							for key, value := range existing {
								merged[key] = value
							}
							if input.OpenCodePriorSpec != nil {
								for key, value := range spec {
									merged[key] = value
								}
							}
							spec = merged
						}
					}
				}
				file.text, e = hostSetConfiguration(file.text, mcpPath, spec)
				if e == nil {
					file.text, e = hostSetConfiguration(file.text, []string{"skills", "paths"}, next)
				}
				if e == nil && (input.OpenCodeLayout == "v2" || input.OpenCodePriorLayout == "v2") {
					plugins := config["plugins"]
					if plugins == nil {
						plugins = []any{}
					}
					list, ok := plugins.([]any)
					if !ok {
						return nil, hostConfigurationFailure("setup_opencode_config_conflict")
					}
					updated := []any{}
					insertAt := -1
					for _, item := range list {
						own := ""
						if v, ok := item.(string); ok {
							own = v
						} else if v, ok := item.([]any); ok && len(v) > 0 {
							own = text(v[0])
						} else if v, ok := item.(map[string]any); ok {
							own = text(v["package"])
						}
						if own == pluginURL || oldPlugin != "" && own == oldPlugin {
							if insertAt < 0 {
								insertAt = len(updated)
							}
							continue
						}
						if insertAt < 0 && (own == "-*" || own == "-galaxy.*" || own == "-galaxy.opencode.stable.server") {
							insertAt = len(updated)
						}
						updated = append(updated, item)
					}
					if input.OpenCodeLayout == "v2" {
						if insertAt < 0 {
							insertAt = len(updated)
						}
						updated = append(updated, nil)
						copy(updated[insertAt+1:], updated[insertAt:])
						updated[insertAt] = pluginURL
					}
					file.text, e = hostSetConfiguration(file.text, []string{"plugins"}, updated)
				}
			} else {
				pluginKey := "plugin"
				if basename == "cli" {
					pluginKey = "plugins"
				}
				plugins := config[pluginKey]
				if plugins == nil {
					plugins = []any{}
				}
				list, ok := plugins.([]any)
				if !ok {
					return nil, hostConfigurationFailure("setup_opencode_config_conflict")
				}
				next := []any{}
				insertAt := -1
				for _, item := range list {
					own := ""
					if value, ok := item.(string); ok {
						own = value
					} else if tuple, ok := item.([]any); ok && len(tuple) > 0 {
						own = text(tuple[0])
					} else if object, ok := item.(map[string]any); ok {
						own = text(object["package"])
					}
					if own == pluginURL || oldPlugin != "" && own == oldPlugin {
						if insertAt < 0 {
							insertAt = len(next)
						}
						continue
					}
					if basename == "cli" && insertAt < 0 && (own == "-*" || own == "-galaxy.*" || own == "-galaxy.opencode.stable.tui") {
						insertAt = len(next)
					}
					next = append(next, item)
				}
				if !(basename == "tui" && input.OpenCodeLayout == "v2") && basename != "cli" {
					if insertAt < 0 {
						insertAt = len(next)
					}
					next = append(next, nil)
					copy(next[insertAt+1:], next[insertAt:])
					next[insertAt] = pluginURL
				}
				file.text, e = hostSetConfiguration(file.text, []string{pluginKey}, next)
			}
			if e != nil {
				return nil, e
			}
			if _, e = hostConfigurationObject(file.text); e != nil {
				return nil, e
			}
			plan.files = append(plan.files, file)
			plan.ConfigurationFiles = append(plan.ConfigurationFiles, file.path)
		}
	}
	return plan, nil
}

// The caller obtains the original installation decision before this method.
// Each saved source is checked again before any write and at its own replace;
// separate profile files retain the original non-atomic publication behavior.
func InstallOpenCodeConfigurationReviewed(ctx context.Context, plan *OpenCodeConfigurationPlan, confirmed bool) (map[string]any, error) {
	if !confirmed || plan == nil {
		return nil, hostConfigurationFailure("setup_installation_choice_required")
	}
	if e := ctx.Err(); e != nil {
		return nil, e
	}
	for _, file := range plan.files {
		raw, e := os.ReadFile(file.path)
		if file.missing {
			if e == nil || !os.IsNotExist(e) {
				return nil, hostConfigurationFailure("setup_opencode_config_changed")
			}
		} else if e != nil || string(raw) != file.previous {
			return nil, hostConfigurationFailure("setup_opencode_config_changed")
		}
	}
	for _, file := range []struct {
		path, previous string
		present        bool
	}{{filepath.Join(plan.Directory, "galaxy-installation.json"), plan.metadata, plan.metadataExists}, {plan.Plugin, plan.pluginPrevious, plan.pluginExists}} {
		raw, e := os.ReadFile(file.path)
		if file.present {
			if e != nil || string(raw) != file.previous {
				return nil, hostConfigurationFailure("setup_opencode_config_changed")
			}
		} else if e == nil || !os.IsNotExist(e) {
			return nil, hostConfigurationFailure("setup_opencode_config_changed")
		}
	}
	if e := os.MkdirAll(plan.Directory, 0700); e != nil {
		return nil, e
	}
	if e := hostDirectory(plan.Directory); e != nil {
		return nil, e
	}
	publish := func(path, text, prior string, present bool) error {
		if e := ctx.Err(); e != nil {
			return e
		}
		if !present {
			return hostWriteNew(path, []byte(text))
		}
		return hostReplaceSelected(path, text, &prior)
	}
	if e := os.MkdirAll(filepath.Dir(plan.Plugin), 0700); e != nil {
		return nil, e
	}
	pluginText := hostOpenCodePlugin(plan.input)
	if plan.input.OpenCodeLayout == "v2" {
		pluginText = hostOpenCodeV2Plugin(plan.input)
	}
	if e := publish(plan.Plugin, pluginText, plan.pluginPrevious, plan.pluginExists); e != nil {
		return nil, e
	}
	for _, file := range plan.files {
		if e := publish(file.path, file.text, file.previous, !file.missing); e != nil {
			return nil, e
		}
	}
	pluginRef := hostFileURL(plan.Plugin)
	if plan.input.OpenCodeLayout == "v2" {
		pluginRef = hostFileURL(filepath.Dir(plan.Plugin))
	}
	metadata, e := hostJSON(map[string]any{"version": 1, "plugin": pluginRef, "skillPath": plan.SkillsPath, "configPath": plan.input.ConfigPath, "dataDirectory": plan.input.DataDirectory, "endpoint": plan.input.Endpoint})
	if e != nil {
		return nil, e
	}
	if e = publish(filepath.Join(plan.Directory, "galaxy-installation.json"), string(metadata), plan.metadata, plan.metadataExists); e != nil {
		return nil, e
	}
	return map[string]any{"directory": plan.Directory, "plugin": plan.Plugin, "actualSettingsModified": true}, nil
}
