package native

import (
	"os"
	"path/filepath"
)

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
