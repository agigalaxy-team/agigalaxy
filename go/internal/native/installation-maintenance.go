package native

import (
	"context"
	"os"
	"path/filepath"
)

// ManagedOpenCodeReady checks the selected managed profile without traversing
// or hashing the immutable release's dependency tree. A pending transaction or
// incomplete owned configuration proceeds through normal repair and recovery.
func ManagedOpenCodeReady(ctx context.Context, input ManagedNativeInstallationInput) (bool, error) {
	if input.Host != "opencode" || !filepath.IsAbs(input.Home) || !filepath.IsAbs(input.InstallRoot) || !filepath.IsAbs(input.PackageDirectory) || !filepath.IsAbs(input.DataDirectory) {
		return false, hostConfigurationFailure("setup_path_invalid")
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	config, _, err := NativeUserHostPaths(input.Host, input.Home, input.Environment)
	if err != nil {
		return false, err
	}
	path, err := managedRecordPath(input.InstallRoot, input.Host, config)
	if err != nil {
		return false, err
	}
	if err = hostFile(path); err != nil {
		return false, err
	}
	var record managedNativeRecord
	present, err := readJSON(path, &record)
	if err != nil {
		return false, err
	}
	if !present || record.Version != 1 || record.Host != input.Host || !installationSamePath(record.HostConfigPath, config) || !installationSamePath(record.ReleaseDirectory, input.PackageDirectory) || !installationSamePath(record.DataDirectory, input.DataDirectory) || record.LocalOnly != input.LocalOnly || (record.ConfigPath != "" || input.ConfigPath != "") && !installationSamePath(record.ConfigPath, input.ConfigPath) {
		return false, hostConfigurationFailure("setup_existing_installation_conflict")
	}
	if !record.LocalOnly {
		configuration, e := ReadConfiguration(record.ConfigPath)
		if e != nil {
			return false, e
		}
		if !installationSamePath(configuration.DataDirectory, record.DataDirectory) || configuration.Endpoint != record.Endpoint {
			return false, hostConfigurationFailure("setup_configuration_conflict")
		}
	}
	if _, err = os.Lstat(path + ".pending"); err == nil {
		return false, nil
	} else if !os.IsNotExist(err) {
		return false, err
	}
	ready, err := managedNativeStateMatches(&record)
	if err != nil || ready {
		return ready, err
	}
	// Prove the existing owned entries are safe to reconcile before the normal
	// repair path copies a release or writes any profile files.
	if err = managedOpenCodeCheck(config, &record); err != nil {
		return false, err
	}
	preview := HostConfigurationInput{PackageDirectory: input.PackageDirectory, ConfigPath: record.ConfigPath, DataDirectory: record.DataDirectory, Endpoint: record.Endpoint, LocalOnly: record.LocalOnly, OpenCodeLayout: record.OpenCodeLayout, OpenCodePriorLayout: record.OpenCodeLayout, OpenCodePriorSpec: record.ManagedSpec}
	if _, err = PreviewOpenCodeConfiguration(ctx, config, preview); err != nil {
		return false, err
	}
	return false, nil
}

// ResolveManagedNativeMaintenance fills only flags the caller did not supply.
// Existing service configuration and data scope remain the default for repair
// and update; a caller's explicit conflicting choices remain visible to the
// ordinary preview checks rather than silently switching profiles.
// supplied keys are "data-dir", "config", "local-only", "node", "package-dir".
func ResolveManagedNativeMaintenance(input ManagedNativeInstallationInput, supplied map[string]bool) (ManagedNativeInstallationInput, error) {
	if !filepath.IsAbs(input.InstallRoot) || !isOne(input.Host, "opencode", "codex", "claude-code", "cursor", "hermes", "deepseek-harness", "github-copilot", "github-copilot-cli", "custom") {
		return input, hostConfigurationFailure("setup_path_invalid")
	}
	config := input.UserMCPPath
	if config == "" && input.Host != "custom" && filepath.IsAbs(input.Home) {
		if selected, _, e := NativeUserHostPaths(input.Host, input.Home, input.Environment); e == nil {
			config = selected
		}
	}
	path, err := managedRecordPath(input.InstallRoot, input.Host, config)
	if err != nil {
		return input, err
	}
	fallback := false
	if e := hostFile(path); e != nil {
		if !os.IsNotExist(e) {
			return input, e
		}
		if config != "" {
			legacy, lookupErr := managedRecordPath(input.InstallRoot, input.Host, "")
			if lookupErr != nil {
				return input, lookupErr
			}
			if legacy != path {
				if e = hostFile(legacy); e == nil {
					path = legacy
					fallback = true
				} else if !os.IsNotExist(e) {
					return input, e
				}
			}
		}
		if e != nil && !fallback {
			return input, hostConfigurationFailure("setup_installation_missing")
		}
	}

	var record managedNativeRecord
	ok, err := readJSON(path, &record)
	if err != nil {
		return input, err
	}
	if !ok || record.Version != 1 || record.Host != input.Host {
		return input, hostConfigurationFailure("setup_installation_missing")
	}
	if input.Host == "custom" && !fallback {
		if input.UserMCPPath == "" {
			input.UserMCPPath = record.HostConfigPath
		}
		if input.UserSkillPath == "" {
			input.UserSkillPath = record.SkillPath
		}
		if input.UserMCPFormat == "" {
			input.UserMCPFormat = record.ConfigFormat
		}
	}
	if !supplied["data-dir"] {
		if supplied["config"] && input.ConfigPath != "" {
			absolute, e := filepath.Abs(input.ConfigPath)
			if e != nil {
				return input, e
			}
			input.ConfigPath = absolute
			c, e := ReadConfiguration(input.ConfigPath)
			if e != nil {
				return input, e
			}
			input.DataDirectory = c.DataDirectory
		} else {
			input.DataDirectory = record.DataDirectory
		}
	}
	if !supplied["config"] && !supplied["local-only"] {
		input.ConfigPath = record.ConfigPath
		input.LocalOnly = record.LocalOnly
		input.Endpoint = record.Endpoint
	}
	input.PendingWebsite = record.PendingWebsite
	if !supplied["node"] && record.NodeExecutable != "" {
		input.NodeExecutable = record.NodeExecutable
	}
	if input.Host != "opencode" && !supplied["host-executable"] && record.HostExecutable != "" {
		input.HostExecutable = record.HostExecutable
	}
	if !supplied["package-dir"] {
		input.PackageDirectory = record.ReleaseDirectory
	}
	return input, nil
}
