package native

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
)

// RemoveUserHostConfiguration removes only the exact managed MCP entry and a
// skill still matching the supplied immutable release. Application data and
// other host configuration are never removed.
func RemoveUserHostConfiguration(ctx context.Context, host, configPath, skillPath, releaseSkill string, managedSpec any, retainSkill bool) (map[string]any, error) {
	for _, p := range []string{configPath, skillPath, releaseSkill} {
		if !filepath.IsAbs(p) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(configPath)
	missing := os.IsNotExist(err)
	if err != nil && !missing {
		return nil, err
	}
	if !missing {
		if err = hostFile(configPath); err != nil {
			return nil, err
		}
	}
	var updated string
	if !missing {
		object, e := hostConfigurationObject(string(raw))
		if e != nil {
			return nil, e
		}
		existing, ok := uploadObject(object[managedUserMCPKey(host)])["galaxy"]
		if ok && !reflect.DeepEqual(existing, managedSpec) {
			return nil, hostConfigurationFailure("setup_host_config_changed")
		}
		if ok {
			updated, e = hostRemoveConfiguration(string(raw), []string{managedUserMCPKey(host), "galaxy"})
			if e != nil {
				return nil, e
			}
			if _, e = hostConfigurationObject(updated); e != nil {
				return nil, e
			}
		}
	}
	_, err = os.Lstat(skillPath)
	skillMissing := os.IsNotExist(err)
	if err != nil && !skillMissing {
		return nil, err
	}
	if !skillMissing && !retainSkill {
		same, e := installationSkillEqual(skillPath, releaseSkill)
		if e != nil {
			return nil, e
		}
		if !same {
			return nil, hostConfigurationFailure("setup_skill_conflict")
		}
	}
	if updated != "" {
		original := string(raw)
		if err = hostReplaceSelected(configPath, updated, &original); err != nil {
			return nil, err
		}
	}
	if !skillMissing && !retainSkill {
		if err = os.RemoveAll(skillPath); err != nil {
			return map[string]any{"configRemoved": true, "skillRemoved": false, "dataPreserved": true}, err
		}
	}
	return map[string]any{"configRemoved": true, "skillRemoved": !retainSkill, "skillRetained": retainSkill, "dataPreserved": true}, nil
}

func hostRemoveConfiguration(text string, path []string) (string, error) {
	clean, err := hostWithoutComments(text)
	if err != nil {
		return "", err
	}
	var remove func(int, []string) (string, error)
	remove = func(start int, parts []string) (string, error) {
		members, end, err := hostMembers(clean, start)
		if err != nil {
			return "", err
		}
		index := -1
		for i, m := range members {
			if m.key == parts[0] {
				if index >= 0 {
					return "", hostConfigurationFailure("setup_host_config_conflict")
				}
				index = i
			}
		}
		if index < 0 {
			return "", hostConfigurationFailure("setup_host_config_changed")
		}
		member := members[index]
		if len(parts) > 1 {
			if clean[member.begin] != '{' {
				return "", hostConfigurationFailure("setup_host_config_conflict")
			}
			return remove(member.begin, parts[1:])
		}
		// Locate the member's key and consume a neighbouring comma, preserving
		// all text outside that member including unrelated comments.
		keyStart := start + 1
		if index > 0 {
			keyStart = members[index-1].end
		}
		for keyStart < member.begin && (clean[keyStart] == ',' || hostSpace(clean, keyStart) > 0) {
			keyStart++
		}
		from, to := keyStart, member.end
		if index < len(members)-1 {
			comma := strings.Index(clean[to:end], ",")
			if comma < 0 {
				return "", hostConfigurationFailure("setup_host_config_conflict")
			}
			to += comma + 1
		} else if index > 0 {
			comma := strings.LastIndex(clean[members[index-1].end:keyStart], ",")
			if comma < 0 {
				return "", hostConfigurationFailure("setup_host_config_conflict")
			}
			from = members[index-1].end + comma
		}
		return text[:from] + text[to:], nil
	}
	return remove(strings.Index(clean, "{"), path)
}

// RemoveCodexNativeConfiguration removes a previously returned exact block;
// no other TOML or user data is modified.
func RemoveCodexNativeConfiguration(path, block string) error {
	if !filepath.IsAbs(path) || !strings.HasPrefix(block, codexGalaxyBegin) || !strings.HasSuffix(block, codexGalaxyEnd) {
		return hostConfigurationFailure("setup_path_invalid")
	}
	if err := hostFile(path); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	original := string(raw)
	if !codexHasManagedMarker(original) {
		return nil
	}
	remaining, matched := removeRecordedCodexBlock(original, block)
	if !matched {
		return hostConfigurationFailure("setup_host_config_changed")
	}
	return hostReplaceSelected(path, remaining, &original)
}
