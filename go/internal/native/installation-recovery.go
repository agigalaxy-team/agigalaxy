package native

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
)

type managedNativeJournal struct {
	Version  int                  `json:"version"`
	Target   managedNativeRecord  `json:"target"`
	Prior    *managedNativeRecord `json:"prior,omitempty"`
	Baseline map[string]string    `json:"baseline"`
	PriorRaw string               `json:"priorRaw,omitempty"`
}

// Recover only settles a completed target or an untouched prior state. If a
// host write stopped between files, leave the evidence in place for review.
func recoverManagedNativeInstallation(recordPath string) error {
	path := recordPath + ".pending"
	if err := hostFile(path); err != nil {
		return err
	}
	var j managedNativeJournal
	present, err := readJSON(path, &j)
	if err != nil {
		return err
	}
	if !present || j.Version != 1 || j.Target.Version != 1 {
		return hostConfigurationFailure("setup_installation_recovery_required")
	}
	current, readErr := os.ReadFile(recordPath)
	missing := os.IsNotExist(readErr)
	if readErr != nil && !missing {
		return readErr
	}
	if j.Target.Host == "opencode" {
		reconciled, e := reconcileManagedOpenCode(&j)
		if e != nil {
			return e
		}
		_ = reconciled
	}
	matches, err := managedNativeStateMatches(&j.Target)
	if err != nil {
		return err
	}
	if matches {
		if missing {
			baseline, e := managedNativeBaseline(&j.Target)
			if e != nil {
				return e
			}
			if reflect.DeepEqual(baseline, j.Baseline) && ((j.Prior == nil && missing) || (j.Prior != nil && !missing && string(current) == j.PriorRaw)) {
				return os.Remove(path)
			}
			if j.Prior != nil {
				return hostConfigurationFailure("setup_host_config_changed")
			}
			raw, e := hostJSON(j.Target)
			if e != nil {
				return e
			}
			if e = hostWriteNew(recordPath, raw); e != nil {
				return e
			}
		} else {
			var currentRecord managedNativeRecord
			ok, e := readJSON(recordPath, &currentRecord)
			if e != nil || !ok {
				return hostConfigurationFailure("setup_host_config_changed")
			}
			if !reflect.DeepEqual(currentRecord, j.Target) {
				if j.Prior == nil || string(current) != j.PriorRaw {
					return hostConfigurationFailure("setup_host_config_changed")
				}
				raw, e := hostJSON(j.Target)
				if e != nil {
					return e
				}
				old := string(current)
				if e = hostReplaceSelected(recordPath, string(raw), &old); e != nil {
					return e
				}
			}
		}
		return os.Remove(path)
	}
	if j.Prior != nil {
		priorMatches, e := managedNativeStateMatches(j.Prior)
		if e != nil {
			return e
		}
		if priorMatches && !missing && string(current) == j.PriorRaw {
			return os.Remove(path)
		}
	} else if missing {
		empty, e := managedNativeStateEmpty(&j.Target)
		if e != nil {
			return e
		}
		if empty {
			return os.Remove(path)
		}
	}
	return hostConfigurationFailure("setup_installation_recovery_required")
}
func managedNativeStateMatches(r *managedNativeRecord) (bool, error) {
	if r == nil {
		return false, nil
	}
	if r.Host == "opencode" {
		if err := managedOpenCodeCheck(r.HostConfigPath, r); err != nil {
			return false, nil
		}
		var meta map[string]any
		present, err := readJSON(filepath.Join(r.HostConfigPath, "galaxy-installation.json"), &meta)
		if err != nil {
			return false, err
		}
		if !present || text(meta["skillPath"]) != filepath.Join(r.ReleaseDirectory, "skills") || text(meta["plugin"]) != hostFileURL(filepath.Join(r.HostConfigPath, "galaxy-native.tui.mjs")) {
			return false, nil
		}
		files, err := hostSelectedConfigurations(r.HostConfigPath, "opencode")
		if err != nil {
			return false, err
		}
		found := false
		for _, f := range files {
			if f.missing {
				continue
			}
			obj, e := hostConfigurationObject(f.text)
			if e != nil {
				return false, e
			}
			if reflect.DeepEqual(uploadObject(obj["mcp"])["galaxy"], r.ManagedSpec) {
				found = true
			}
		}
		return found, nil
	}
	if r.Host == "deepseek-harness" {
		spec, ok := r.ManagedSpec.(map[string]any)
		if !ok {
			return false, nil
		}
		configured, e := dshConfigured(r.HostConfigPath, spec)
		if e != nil || !configured {
			return false, e
		}
		same, e := installationSkillEqual(r.SkillPath, filepath.Join(r.ReleaseDirectory, "skills", "galaxy"))
		if os.IsNotExist(e) {
			return false, nil
		}
		return same, e
	}
	if r.Host == "hermes" {
		spec, ok := r.ManagedSpec.(map[string]any)
		if !ok {
			return false, nil
		}
		configured, e := hermesConfigured(r.HostConfigPath, spec)
		if e != nil || !configured {
			return false, e
		}
		for _, item := range []struct{ target, source string }{{r.SkillPath, filepath.Join(r.ReleaseDirectory, "skills", "galaxy")}, {r.ManagedPluginPath, filepath.Join(r.ReleaseDirectory, "host-adapters", "hermes")}} {
			same, e := installationSkillEqual(item.target, item.source)
			if item.target == r.ManagedPluginPath {
				same, e = installationHermesEqual(item.target, item.source)
			}
			if os.IsNotExist(e) {
				return false, nil
			}
			if e != nil || !same {
				return false, e
			}
		}
		return true, nil
	}
	raw, err := os.ReadFile(r.HostConfigPath)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if managedRecordAdapter(r) == "codex" || managedRecordAdapter(r) == "custom-toml" {
		if _, matched := removeRecordedCodexBlock(string(raw), r.CodexBlock); !matched {
			return false, nil
		}
	} else {
		obj, e := hostConfigurationObject(string(raw))
		if e != nil {
			return false, e
		}
		if !reflect.DeepEqual(uploadObject(obj[managedUserMCPKey(managedRecordAdapter(r))])["galaxy"], r.ManagedSpec) {
			return false, nil
		}
	}
	same, err := installationSkillEqual(r.SkillPath, filepath.Join(r.ReleaseDirectory, "skills", "galaxy"))
	if os.IsNotExist(err) {
		return false, nil
	}
	return same, err
}
func managedNativeStateEmpty(r *managedNativeRecord) (bool, error) {
	if r.Host == "opencode" {
		files, err := hostSelectedConfigurations(r.HostConfigPath, "opencode")
		if err != nil {
			return false, err
		}
		for _, f := range files {
			if f.missing {
				continue
			}
			obj, e := hostConfigurationObject(f.text)
			if e != nil {
				return false, e
			}
			if _, ok := uploadObject(obj["mcp"])["galaxy"]; ok {
				return false, nil
			}
		}
		_, err = os.Lstat(filepath.Join(r.HostConfigPath, "galaxy-native.tui.mjs"))
		return os.IsNotExist(err), nil
	}
	if r.Host == "hermes" || r.Host == "deepseek-harness" {
		return false, nil
	}
	_, err := os.Lstat(r.SkillPath)
	if err == nil {
		return false, nil
	}
	if !os.IsNotExist(err) {
		return false, err
	}
	raw, err := os.ReadFile(r.HostConfigPath)
	if os.IsNotExist(err) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	if managedRecordAdapter(r) == "codex" || managedRecordAdapter(r) == "custom-toml" {
		return !codexHasManagedMarker(string(raw)) && !codexGalaxySection.Match(raw), nil
	}
	obj, err := hostConfigurationObject(string(raw))
	if err != nil {
		return false, err
	}
	_, found := uploadObject(obj[managedUserMCPKey(managedRecordAdapter(r))])["galaxy"]
	return !found, nil
}

// Baselines contain only path-relative hashes, never host configuration bytes.
func managedNativeBaseline(r *managedNativeRecord) (map[string]string, error) {
	paths := []string{r.HostConfigPath}
	if r.Host == "opencode" {
		paths = nil
		for _, name := range []string{"opencode.json", "opencode.jsonc", "tui.json", "tui.jsonc", "galaxy-native.tui.mjs", "galaxy-installation.json"} {
			paths = append(paths, filepath.Join(r.HostConfigPath, name))
		}
	} else {
		paths = append(paths, r.SkillPath)
	}
	if r.Host == "hermes" {
		paths = append(paths, r.ManagedPluginPath)
	}
	result := map[string]string{}
	for _, root := range paths {
		_, err := os.Lstat(root)
		if os.IsNotExist(err) {
			result[root] = "missing"
			continue
		}
		if err != nil {
			return nil, err
		}
		h := sha256.New()
		err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, e := filepath.Rel(root, path)
			if e != nil {
				return e
			}
			if d.Type()&os.ModeSymlink != 0 {
				return hostConfigurationFailure("setup_host_config_conflict")
			}
			if d.IsDir() {
				_, e = fmt.Fprintf(h, "D:%s\n", rel)
				return e
			}
			if !d.Type().IsRegular() {
				return hostConfigurationFailure("setup_host_config_conflict")
			}
			if _, e = fmt.Fprintf(h, "F:%s\n", rel); e != nil {
				return e
			}
			f, e := os.Open(path)
			if e != nil {
				return e
			}
			_, e = io.Copy(h, f)
			closeErr := f.Close()
			if e != nil {
				return e
			}
			return closeErr
		})
		if err != nil {
			return nil, err
		}
		result[root] = hex.EncodeToString(h.Sum(nil))
	}
	return result, nil
}

// OpenCode writes several files. When an interrupted write left only exact
// old/new Galaxy entries, finish the same plan while preserving other entries.
func reconcileManagedOpenCode(j *managedNativeJournal) (bool, error) {
	target := &j.Target
	targetSpec, err := managedOpenCodeSpec(target)
	if err != nil {
		return false, err
	}
	priorSpec, err := managedOpenCodeSpec(j.Prior)
	if err != nil {
		return false, err
	}
	files, err := hostSelectedConfigurations(target.HostConfigPath, "opencode")
	if err != nil {
		return false, err
	}
	for _, f := range files {
		if f.missing {
			continue
		}
		obj, e := hostConfigurationObject(f.text)
		if e != nil {
			return false, e
		}
		if existing, ok := uploadObject(obj["mcp"])["galaxy"]; ok && !reflect.DeepEqual(existing, targetSpec) && !reflect.DeepEqual(existing, priorSpec) {
			return false, nil
		}
	}
	plugin := filepath.Join(target.HostConfigPath, "galaxy-native.tui.mjs")
	raw, err := os.ReadFile(plugin)
	if err == nil {
		targetInput := HostConfigurationInput{LocalOnly: target.LocalOnly, PackageDirectory: target.ReleaseDirectory, ConfigPath: target.ConfigPath, DataDirectory: target.DataDirectory, Endpoint: target.Endpoint}
		allowed := string(raw) == hostOpenCodePlugin(targetInput)
		if j.Prior != nil {
			p := j.Prior
			priorInput := HostConfigurationInput{LocalOnly: p.LocalOnly, PackageDirectory: p.ReleaseDirectory, ConfigPath: p.ConfigPath, DataDirectory: p.DataDirectory, Endpoint: p.Endpoint}
			allowed = allowed || string(raw) == hostOpenCodePlugin(priorInput)
		}
		if !allowed {
			return false, nil
		}
	} else if !os.IsNotExist(err) {
		return false, err
	}
	pluginMissing := os.IsNotExist(err)
	var meta map[string]any
	present, err := readJSON(filepath.Join(target.HostConfigPath, "galaxy-installation.json"), &meta)
	if err != nil {
		return false, err
	}
	if present {
		skill := text(meta["skillPath"])
		allowed := skill == filepath.Join(target.ReleaseDirectory, "skills")
		if j.Prior != nil {
			allowed = allowed || skill == filepath.Join(j.Prior.ReleaseDirectory, "skills")
		}
		if !allowed || text(meta["plugin"]) != hostFileURL(plugin) {
			return false, nil
		}
	}
	// Do not create an installation if no part was written: the baseline branch
	// can discard this journal and restart the normal plan instead.
	if pluginMissing && !present {
		return false, nil
	}
	input := HostConfigurationInput{LocalOnly: target.LocalOnly, PackageDirectory: target.ReleaseDirectory, ConfigPath: target.ConfigPath, DataDirectory: target.DataDirectory, Endpoint: target.Endpoint}
	plan, err := PreviewOpenCodeConfiguration(context.Background(), target.HostConfigPath, input)
	if err != nil {
		return false, err
	}
	_, err = InstallOpenCodeConfigurationReviewed(context.Background(), plan, true)
	return err == nil, err
}
