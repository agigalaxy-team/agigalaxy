package native

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// NativeUserHostPaths returns only the selected host's user-scoped locations.
// These paths describe configuration, not proof that the host loaded it.
func NativeUserHostPaths(host, home string, environment map[string]string) (configPath, skillPath string, err error) {
	if !filepath.IsAbs(home) {
		return "", "", hostConfigurationFailure("setup_path_invalid")
	}
	switch host {
	case "deepseek-harness":
		return dshUserPaths(home, environment)
	case "hermes":
		dir, e := hermesHome(home, environment)
		if e != nil {
			return "", "", e
		}
		return filepath.Join(dir, "config.yaml"), filepath.Join(dir, "skills", "galaxy"), nil
	case "opencode":
		configPath, err = OpenCodeConfigurationDirectory(environment, home)
		return configPath, "", err
	case "claude-code":
		return filepath.Join(home, ".claude.json"), filepath.Join(home, ".claude", "skills", "galaxy"), nil
	case "github-copilot":
		profile := environment["GALAXY_VSCODE_PROFILE_DIR"]
		if profile == "" {
			switch runtime.GOOS {
			case "windows":
				base := environment["APPDATA"]
				if base == "" {
					base = filepath.Join(home, "AppData", "Roaming")
				}
				profile = filepath.Join(base, "Code", "User")
			case "darwin":
				profile = filepath.Join(home, "Library", "Application Support", "Code", "User")
			default:
				base := environment["XDG_CONFIG_HOME"]
				if base == "" {
					base = filepath.Join(home, ".config")
				}
				profile = filepath.Join(base, "Code", "User")
			}
		}
		if !filepath.IsAbs(profile) {
			return "", "", hostConfigurationFailure("setup_path_invalid")
		}
		return filepath.Join(profile, "mcp.json"), filepath.Join(home, ".copilot", "skills", "galaxy"), nil
	case "github-copilot-cli":
		dir := environment["COPILOT_HOME"]
		if dir == "" {
			dir = filepath.Join(home, ".copilot")
		}
		if !filepath.IsAbs(dir) {
			return "", "", hostConfigurationFailure("setup_path_invalid")
		}
		return filepath.Join(dir, "mcp-config.json"), filepath.Join(home, ".copilot", "skills", "galaxy"), nil
	case "cursor":
		return filepath.Join(home, ".cursor", "mcp.json"), filepath.Join(home, ".cursor", "skills", "galaxy"), nil
	case "codex":
		dir := environment["CODEX_HOME"]
		if dir == "" {
			dir = filepath.Join(home, ".codex")
		}
		if !filepath.IsAbs(dir) {
			return "", "", hostConfigurationFailure("setup_path_invalid")
		}
		return filepath.Join(dir, "config.toml"), filepath.Join(home, ".agents", "skills", "galaxy"), nil
	default:
		return "", "", hostConfigurationFailure("setup_host_user_scope_unsupported")
	}
}

const codexGalaxyBegin = "# BEGIN GALAXY MANAGED MCP\n"
const codexGalaxyEnd = "# END GALAXY MANAGED MCP\n"

var codexGalaxySection = regexp.MustCompile(`(?m)^\s*\[\s*(mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(galaxy|"galaxy"|'galaxy')\s*(\.|\])`)

func codexHasManagedMarker(text string) bool {
	return strings.Contains(text, strings.TrimSuffix(codexGalaxyBegin, "\n")) ||
		strings.Contains(text, strings.TrimSuffix(codexGalaxyEnd, "\n"))
}

// removeRecordedCodexBlock identifies only the previously generated MCP tables.
// Codex may move the end comment after tables it appends; those tables are not
// part of the installation. The generated table bytes must still match exactly.
func removeRecordedCodexBlock(text, block string) (string, bool) {
	if !strings.HasPrefix(block, codexGalaxyBegin) || !strings.HasSuffix(block, codexGalaxyEnd) {
		return text, false
	}
	begin, endMarker := codexGalaxyBegin, codexGalaxyEnd
	if strings.Contains(text, strings.ReplaceAll(begin, "\n", "\r\n")) {
		begin = strings.ReplaceAll(begin, "\n", "\r\n")
		endMarker = strings.ReplaceAll(endMarker, "\n", "\r\n")
		block = strings.ReplaceAll(block, "\n", "\r\n")
	}
	if strings.Count(text, begin) != 1 || strings.Count(text, endMarker) != 1 {
		return text, false
	}
	body := strings.TrimSuffix(block, endMarker)
	if strings.Count(text, body) != 1 {
		return text, false
	}
	start := strings.Index(text, body)
	end := strings.Index(text, endMarker)
	if end < start+len(body) {
		return text, false
	}
	// A key before the next table still belongs to the managed MCP table,
	// even if the end comment sits before it. Treat it as a user change.
	tail := strings.Replace(text[start+len(body):], endMarker, "", 1)
	for _, line := range strings.Split(tail, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !strings.HasPrefix(line, "[") {
			return text, false
		}
		break
	}
	remaining := text[:start] + tail
	if codexGalaxySection.MatchString(remaining) {
		return text, false
	}
	return remaining, true
}

// UpdateCodexNativeConfiguration publishes only the managed TOML block. An
// existing unrelated galaxy table is a conflict. previousBlock is the exact
// block recorded by the prior install; pass empty for a first installation.
// Skill installation is separate, so callers report each step independently.
func UpdateCodexNativeConfiguration(path string, input HostConfigurationInput, previousBlock string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", hostConfigurationFailure("setup_path_invalid")
	}
	entry, err := hostCandidate(input.PackageDirectory)
	if err != nil {
		return "", err
	}
	if !input.LocalOnly {
		if !filepath.IsAbs(input.ConfigPath) {
			return "", hostConfigurationFailure("setup_path_invalid")
		}
		if err = hostFile(input.ConfigPath); err != nil {
			return "", err
		}
	}
	raw, err := os.ReadFile(path)
	missing := os.IsNotExist(err)
	if err != nil && !missing {
		return "", err
	}
	if missing {
		raw = []byte{}
	} else if err = hostFile(path); err != nil {
		return "", err
	}
	original := string(raw)
	text := original
	if previousBlock != "" {
		if !strings.HasPrefix(previousBlock, codexGalaxyBegin) || !strings.HasSuffix(previousBlock, codexGalaxyEnd) {
			return "", hostConfigurationFailure("setup_host_config_changed")
		}
		if codexHasManagedMarker(text) {
			var matched bool
			text, matched = removeRecordedCodexBlock(text, previousBlock)
			if !matched {
				return "", hostConfigurationFailure("setup_host_config_changed")
			}
		}
	}
	if codexHasManagedMarker(text) || codexGalaxySection.MatchString(text) {
		return "", hostConfigurationFailure("setup_host_config_conflict")
	}
	args, environment := input.launch()
	block := codexGalaxyBegin + "[mcp_servers.galaxy]\ncommand = " + hostJSONString(entry) + "\nargs = " + hostJSONString(args) + "\n"
	if !input.LocalOnly {
		block += "\n[mcp_servers.galaxy.env]\nGALAXY_NATIVE_CONFIG = " + hostJSONString(environment["GALAXY_NATIVE_CONFIG"]) + "\n"
	}
	block += codexGalaxyEnd
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	text += "\n" + block
	if missing {
		err = hostWriteNew(path, []byte(text))
	} else {
		err = hostReplaceSelected(path, text, &original)
	}
	if err != nil {
		return "", err
	}
	return block, nil
}

func managedCodexBlock(input HostConfigurationInput) (string, error) {
	entry, err := hostCandidate(input.PackageDirectory)
	if err != nil {
		return "", err
	}
	args, env := input.launch()
	block := codexGalaxyBegin + "[mcp_servers.galaxy]\ncommand = " + hostJSONString(entry) + "\nargs = " + hostJSONString(args) + "\n"
	if !input.LocalOnly {
		block += "\n[mcp_servers.galaxy.env]\nGALAXY_NATIVE_CONFIG = " + hostJSONString(env["GALAXY_NATIVE_CONFIG"]) + "\n"
	}
	return block + codexGalaxyEnd, nil
}
