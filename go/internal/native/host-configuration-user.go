package native

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"strings"

	"github.com/google/uuid"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
)

// UserHostConfigurationPlan identifies the selected user's JSON host profile.
// It never discovers or modifies other host profiles.
type UserHostConfigurationPlan struct {
	Host                string `json:"host"`
	ConfigPath          string `json:"configPath"`
	SkillPath           string `json:"skillPath"`
	input               HostConfigurationInput
	original            string
	missing             bool
	priorSpec           any
	priorSkillDirectory string
}

// PreviewUserHostConfiguration supports hosts whose user-level MCP settings
// are JSON objects. The caller supplies the verified host-specific locations.
// Existing galaxy entries are accepted only if they match the prior managed
// entry supplied by the caller, so another installation is never overwritten.
func PreviewUserHostConfiguration(ctx context.Context, host, configPath, skillPath string, input HostConfigurationInput, priorSpec any, priorSkillDirectory string) (*UserHostConfigurationPlan, error) {
	if !isOne(host, "claude-code", "cursor", "github-copilot", "github-copilot-cli", "custom-json-mcpServers", "custom-json-servers") || !filepath.IsAbs(configPath) || !filepath.IsAbs(skillPath) || !filepath.IsAbs(input.PackageDirectory) || !filepath.IsAbs(input.DataDirectory) {
		return nil, hostConfigurationFailure("setup_path_invalid")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := hostCandidate(input.PackageDirectory); err != nil {
		return nil, err
	}
	if err := hostFile(filepath.Join(input.PackageDirectory, "skills", "galaxy", "SKILL.md")); err != nil {
		return nil, err
	}
	if !input.LocalOnly {
		if !filepath.IsAbs(input.ConfigPath) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
		if err := hostFile(input.ConfigPath); err != nil {
			return nil, err
		}
	}
	raw, err := os.ReadFile(configPath)
	missing := os.IsNotExist(err)
	if err != nil && !missing {
		return nil, err
	}
	if missing {
		raw = []byte("{}\n")
	} else if err = hostFile(configPath); err != nil {
		return nil, err
	}
	object, err := hostConfigurationObject(string(raw))
	if err != nil {
		return nil, err
	}
	if existing, ok := uploadObject(object[managedUserMCPKey(host)])["galaxy"]; ok && !reflect.DeepEqual(existing, priorSpec) {
		return nil, hostConfigurationFailure("setup_host_config_conflict")
	}
	return &UserHostConfigurationPlan{Host: host, ConfigPath: configPath, SkillPath: skillPath, input: input, original: string(raw), missing: missing, priorSpec: priorSpec, priorSkillDirectory: priorSkillDirectory}, nil
}

// InstallUserHostConfiguration preserves a locally changed or unowned skill.
// For an update, priorSkillDirectory identifies the previous release skill;
// the installed files must still match it before they are replaced.
func InstallUserHostConfiguration(ctx context.Context, plan *UserHostConfigurationPlan) (map[string]any, error) {
	if plan == nil {
		return nil, hostConfigurationFailure("setup_path_invalid")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entry, err := hostCandidate(plan.input.PackageDirectory)
	if err != nil {
		return nil, err
	}
	args, env := plan.input.launch()
	spec := managedUserMCPSpec(plan.Host, entry, args, env)
	// Normalize JSON types before comparing in later previews.
	encoded, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	var normalized any
	if err = json.Unmarshal(encoded, &normalized); err != nil {
		return nil, err
	}
	updated, err := hostSetConfiguration(plan.original, []string{managedUserMCPKey(plan.Host), "galaxy"}, spec)
	if err != nil {
		return nil, err
	}
	if _, err = hostConfigurationObject(updated); err != nil {
		return nil, err
	}
	if plan.missing {
		if _, err = os.Lstat(plan.ConfigPath); err == nil || !os.IsNotExist(err) {
			return nil, hostConfigurationFailure("setup_host_config_changed")
		}
	} else {
		current, readErr := os.ReadFile(plan.ConfigPath)
		if readErr != nil || string(current) != plan.original {
			return nil, hostConfigurationFailure("setup_host_config_changed")
		}
	}
	err = installationReplaceSkill(plan.SkillPath, filepath.Join(plan.input.PackageDirectory, "skills", "galaxy"), plan.priorSkillDirectory, func() error {
		if plan.missing {
			return hostWriteNew(plan.ConfigPath, []byte(updated))
		}
		return hostReplaceSelected(plan.ConfigPath, updated, &plan.original)
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"host": plan.Host, "configPath": plan.ConfigPath, "skillPath": plan.SkillPath, "managedMcpSpec": normalized, "actualSettingsModified": true, "hostRuntimeTested": false}, nil
}

// Compare a managed skill to its previous immutable release, including all
// files and directories; symbolic links and special files are never followed.
var hermesBytecode = regexp.MustCompile(`^__init__\.cpython-[0-9]+(\.opt-[0-9]+)?\.pyc$`)

func installationSkillEqual(a, b string) (bool, error)  { return installationOwnedEqual(a, b, false) }
func installationHermesEqual(a, b string) (bool, error) { return installationOwnedEqual(a, b, true) }
func installationOwnedEqual(a, b string, allowBytecode bool) (bool, error) {
	scan := func(root string) (map[string][32]byte, error) {
		result := map[string][32]byte{}
		err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			if rel == "." {
				if !d.IsDir() {
					return hostConfigurationFailure("setup_skill_conflict")
				}
				return nil
			}
			if allowBytecode && rel == "__pycache__" && d.IsDir() {
				return nil
			}
			if allowBytecode && filepath.Dir(rel) == "__pycache__" && !d.IsDir() && d.Type().IsRegular() && hermesBytecode.MatchString(d.Name()) {
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				return hostConfigurationFailure("setup_skill_conflict")
			}
			if d.IsDir() {
				result[rel+string(filepath.Separator)] = [32]byte{}
				return nil
			}
			if !d.Type().IsRegular() {
				return hostConfigurationFailure("setup_skill_conflict")
			}
			f, err := os.Open(path)
			if err != nil {
				return err
			}
			h := sha256.New()
			_, err = io.Copy(h, f)
			closeErr := f.Close()
			if err != nil {
				return err
			}
			if closeErr != nil {
				return closeErr
			}
			var digest [32]byte
			copy(digest[:], h.Sum(nil))
			result[rel] = digest
			return nil
		})
		return result, err
	}
	if strings.TrimSpace(a) == "" || strings.TrimSpace(b) == "" {
		return false, hostConfigurationFailure("setup_path_invalid")
	}
	left, err := scan(a)
	if err != nil {
		return false, err
	}
	right, err := scan(b)
	if err != nil {
		return false, err
	}
	return reflect.DeepEqual(left, right), nil
}

// installationReplaceSkill changes only a matching managed skill, and rolls
// it back if publication of the corresponding host configuration fails.
func installationReplaceSkill(target, source, prior string, publish func() error) error {
	return installationReplaceOwned(target, source, prior, publish, false)
}
func installationReplaceHermesPlugin(target, source, prior string, publish func() error) error {
	return installationReplaceOwned(target, source, prior, publish, true)
}
func installationReplaceOwned(target, source, prior string, publish func() error, allowBytecode bool) error {
	if !filepath.IsAbs(target) || !filepath.IsAbs(source) {
		return hostConfigurationFailure("setup_path_invalid")
	}
	exists := false
	if _, err := os.Lstat(target); err == nil {
		exists = true
	} else if !os.IsNotExist(err) {
		return err
	}
	if exists {
		sameNew, e := installationOwnedEqual(target, source, allowBytecode)
		if e != nil {
			return e
		}
		if sameNew {
			return publish()
		}
		if !filepath.IsAbs(prior) {
			return hostConfigurationFailure("setup_skill_conflict")
		}
		same, err := installationOwnedEqual(target, prior, allowBytecode)
		if err != nil {
			return err
		}
		if !same {
			return hostConfigurationFailure("setup_skill_conflict")
		}
	}
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		return err
	}
	staged := target + ".galaxy-new-" + uuid.NewString()
	defer os.RemoveAll(staged)
	if err := hostCopyTree(source, staged); err != nil {
		return err
	}
	backup := target + ".galaxy-old-" + uuid.NewString()
	if exists {
		if err := os.Rename(target, backup); err != nil {
			return err
		}
	}
	if err := os.Rename(staged, target); err != nil {
		if exists {
			_ = os.Rename(backup, target)
		}
		return err
	}
	if err := publish(); err != nil {
		_ = os.RemoveAll(target)
		if exists {
			_ = os.Rename(backup, target)
		}
		return err
	}
	if exists {
		return os.RemoveAll(backup)
	}
	return nil
}

func managedUserMCPSpec(host, entry string, args []string, env map[string]string) map[string]any {
	spec := map[string]any{"type": "stdio", "command": entry, "args": args, "env": env}
	if host == "github-copilot-cli" {
		spec["tools"] = []string{"*"}
	}
	return spec
}

func managedUserMCPKey(host string) string {
	if host == "github-copilot" || host == "custom-json-servers" {
		return "servers"
	}
	return "mcpServers"
}
