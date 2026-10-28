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
	for _, path := range []string{directory, input.PackageDirectory, input.ConfigPath, input.DataDirectory} {
		if !filepath.IsAbs(path) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
	}
	if !serviceConfigurationOrigin(input.Endpoint) {
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
	plan := &OpenCodeConfigurationPlan{Directory: filepath.Clean(directory), Plugin: filepath.Join(directory, "galaxy-native.tui.mjs"), SkillsPath: filepath.Join(input.PackageDirectory, "skills"), input: input, ConfigurationFiles: []string{}}
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
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	pluginURL := hostFileURL(plan.Plugin)
	oldPlugin := text(previous["plugin"])
	oldSkill := text(previous["skillPath"])
	entry := hostExecutable(input.PackageDirectory)
	for _, basename := range []string{"opencode", "tui"} {
		files, e := hostSelectedConfigurations(directory, basename)
		if e != nil {
			return nil, e
		}
		for _, file := range files {
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
				file.text, e = hostSetConfiguration(file.text, []string{"mcp", "galaxy"}, map[string]any{"type": "local", "command": []string{entry, "native"}, "environment": map[string]string{"GALAXY_NATIVE_CONFIG": input.ConfigPath}, "enabled": true})
				if e == nil {
					file.text, e = hostSetConfiguration(file.text, []string{"skills", "paths"}, next)
				}
			} else {
				plugins := config["plugin"]
				if plugins == nil {
					plugins = []any{}
				}
				list, ok := plugins.([]any)
				if !ok {
					return nil, hostConfigurationFailure("setup_opencode_config_conflict")
				}
				next := []any{}
				for _, item := range list {
					own := ""
					if value, ok := item.(string); ok {
						own = value
					} else if tuple, ok := item.([]any); ok && len(tuple) > 0 {
						own = text(tuple[0])
					}
					if own != pluginURL && (oldPlugin == "" || own != oldPlugin) {
						next = append(next, item)
					}
				}
				next = append(next, pluginURL)
				file.text, e = hostSetConfiguration(file.text, []string{"plugin"}, next)
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
	if e := publish(plan.Plugin, hostOpenCodePlugin(plan.input), plan.pluginPrevious, plan.pluginExists); e != nil {
		return nil, e
	}
	for _, file := range plan.files {
		if e := publish(file.path, file.text, file.previous, !file.missing); e != nil {
			return nil, e
		}
	}
	metadata, e := hostJSON(map[string]any{"version": 1, "plugin": hostFileURL(plan.Plugin), "skillPath": plan.SkillsPath, "configPath": plan.input.ConfigPath, "dataDirectory": plan.input.DataDirectory, "endpoint": plan.input.Endpoint})
	if e != nil {
		return nil, e
	}
	if e = publish(filepath.Join(plan.Directory, "galaxy-installation.json"), string(metadata), plan.metadata, plan.metadataExists); e != nil {
		return nil, e
	}
	return map[string]any{"directory": plan.Directory, "plugin": plan.Plugin, "actualSettingsModified": true}, nil
}
