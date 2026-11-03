package native

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// managedRecordPath keeps legacy host records and assigns a stable record to
// each additional user-selected host configuration. No data is migrated.
func managedRecordPath(root, host, configPath string) (string, error) {
	if !filepath.IsAbs(root) || !isOne(host, "opencode", "codex", "claude-code", "cursor", "hermes", "deepseek-harness", "github-copilot", "github-copilot-cli", "custom") {
		return "", hostConfigurationFailure("setup_path_invalid")
	}
	dir := filepath.Join(root, "hosts")
	legacy := filepath.Join(dir, host+".json")
	if configPath == "" {
		return legacy, nil
	}
	if !filepath.IsAbs(configPath) {
		return "", hostConfigurationFailure("setup_path_invalid")
	}
	normalized := filepath.Clean(configPath)
	if runtime.GOOS == "windows" {
		normalized = strings.ToLower(normalized)
	}
	sum := sha256.Sum256([]byte(normalized))
	scoped := filepath.Join(dir, host+"-"+hex.EncodeToString(sum[:8])+".json")
	var record managedNativeRecord
	present, err := readJSON(legacy, &record)
	if err != nil {
		return "", err
	}
	if present {
		if record.Host != host {
			return "", hostConfigurationFailure("setup_host_config_conflict")
		}
		a := filepath.Clean(record.HostConfigPath)
		if runtime.GOOS == "windows" {
			a = strings.ToLower(a)
		}
		if a == normalized {
			return legacy, nil
		}
		return scoped, nil
	}
	if _, err = os.Lstat(scoped); err == nil {
		return scoped, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	return legacy, nil
}
func managedCustomAdapter(format string) string {
	switch format {
	case "json-mcpServers":
		return "custom-json-mcpServers"
	case "json-servers":
		return "custom-json-servers"
	case "toml-mcp_servers":
		return "custom-toml"
	}
	return ""
}
func managedRecordAdapter(record *managedNativeRecord) string {
	if record != nil && record.Host == "custom" {
		return managedCustomAdapter(record.ConfigFormat)
	}
	if record == nil {
		return ""
	}
	return record.Host
}

func installationSamePath(a, b string) bool {
	a = filepath.Clean(a)
	b = filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
