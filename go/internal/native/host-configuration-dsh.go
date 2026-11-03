package native

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"

	yaml "go.yaml.in/yaml/v3"
)

func dshInstallationSpec(input HostConfigurationInput) (map[string]any, error) {
	entry, err := hostCandidate(input.PackageDirectory)
	if err != nil {
		return nil, err
	}
	args, env := input.launch()
	cfg := map[string]any{"serverName": "galaxy", "transport": "stdio", "command": entry, "args": args}
	if len(env) > 0 {
		cfg["env"] = env
	}
	adapter := map[string]any{"executable": entry}
	if input.LocalOnly {
		adapter["dataDirectory"] = input.DataDirectory
	} else {
		adapter["configPath"] = input.ConfigPath
	}
	plugin := filepath.Join(input.PackageDirectory, "host-adapters", "deepseek-harness", "index.mjs")
	if err = hostFile(plugin); err != nil {
		return nil, err
	}
	b, err := json.Marshal(map[string]any{"insert": []any{map[string]any{"id": "mcp-galaxy", "name": "@deepseek-ai/dsh-mcp-client", "config": cfg}, map[string]any{"id": "galaxy-work", "name": plugin, "config": adapter}}})
	if err != nil {
		return nil, err
	}
	var result map[string]any
	err = json.Unmarshal(b, &result)
	return result, err
}
func dshPatch(path string, spec, prior map[string]any, remove bool) error {
	raw, err := os.ReadFile(path)
	missing := os.IsNotExist(err)
	if err != nil && !missing {
		return err
	}
	if missing {
		raw = []byte("[]\n")
	} else if err = hostFile(path); err != nil {
		return err
	}
	var doc yaml.Node
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	if err = dec.Decode(&doc); err != nil {
		return hostConfigurationFailure("setup_host_config_invalid")
	}
	var extra yaml.Node
	if err = dec.Decode(&extra); err != io.EOF {
		return hostConfigurationFailure("setup_host_config_conflict")
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.SequenceNode {
		return hostConfigurationFailure("setup_host_config_conflict")
	}
	rows := doc.Content[0]
	index := -1
	for i, row := range rows.Content {
		if dshContainsManagedID(row) {
			if index >= 0 {
				return hostConfigurationFailure("setup_host_config_conflict")
			}
			index = i
		}
	}
	if index >= 0 {
		var existing any
		if err = rows.Content[index].Decode(&existing); err != nil {
			return hostConfigurationFailure("setup_host_config_invalid")
		}
		if !reflect.DeepEqual(existing, prior) {
			return hostConfigurationFailure("setup_host_config_conflict")
		}
	}
	if remove {
		if index >= 0 {
			rows.Content = append(rows.Content[:index], rows.Content[index+1:]...)
		}
	} else {
		var node yaml.Node
		if err = node.Encode(spec); err != nil {
			return err
		}
		if index >= 0 {
			old := rows.Content[index]
			node.HeadComment = old.HeadComment
			node.LineComment = old.LineComment
			node.FootComment = old.FootComment
			rows.Content[index] = &node
		} else {
			rows.Content = append(rows.Content, &node)
		}
	}
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	if err = enc.Encode(&doc); err != nil {
		return hostConfigurationFailure("setup_host_config_invalid")
	}
	if err = enc.Close(); err != nil {
		return hostConfigurationFailure("setup_host_config_invalid")
	}
	if missing {
		if remove {
			return nil
		}
		return hostWriteNew(path, out.Bytes())
	}
	original := string(raw)
	return hostReplaceSelected(path, out.String(), &original)
}
func dshConfigured(path string, spec map[string]any) (bool, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var doc yaml.Node
	if err = yaml.Unmarshal(raw, &doc); err != nil {
		return false, hostConfigurationFailure("setup_host_config_invalid")
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.SequenceNode {
		return false, hostConfigurationFailure("setup_host_config_conflict")
	}
	found := false
	for _, row := range doc.Content[0].Content {
		if dshContainsManagedID(row) {
			if found {
				return false, hostConfigurationFailure("setup_host_config_conflict")
			}
			found = true
			var actual any
			if e := row.Decode(&actual); e != nil {
				return false, hostConfigurationFailure("setup_host_config_invalid")
			}
			if !reflect.DeepEqual(actual, spec) {
				return false, nil
			}
		}
	}
	return found, nil
}
func dshUserPaths(home string, env map[string]string) (string, string, error) {
	root := env["DSH_HOME"]
	if root == "" {
		root = filepath.Join(home, ".dsh")
	}
	if !filepath.IsAbs(root) {
		return "", "", hostConfigurationFailure("setup_path_invalid")
	}
	profile := env["DSH_PROFILE_DIR"]
	if profile == "" {
		name := env["DSH_PROFILE"]
		if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
			return "", "", hostConfigurationFailure("setup_dsh_profile_required")
		}
		profile = filepath.Join(root, "profiles", name)
	}
	if !filepath.IsAbs(profile) {
		return "", "", hostConfigurationFailure("setup_path_invalid")
	}
	if err := hostDirectory(profile); err != nil {
		return "", "", err
	}
	if err := hostFile(filepath.Join(profile, "package.json")); err != nil {
		return "", "", err
	}
	return filepath.Join(profile, "cordis.patch.yml"), filepath.Join(root, "skills", "galaxy"), nil
}

func dshContainsManagedID(node *yaml.Node) bool {
	seen := map[*yaml.Node]bool{}
	var visit func(*yaml.Node) bool
	visit = func(n *yaml.Node) bool {
		if n == nil || seen[n] {
			return false
		}
		seen[n] = true
		if n.Kind == yaml.AliasNode {
			return visit(n.Alias)
		}
		if n.Kind == yaml.MappingNode {
			for i := 0; i+1 < len(n.Content); i += 2 {
				if n.Content[i].Value == "id" && (n.Content[i+1].Value == "mcp-galaxy" || n.Content[i+1].Value == "galaxy-work") {
					return true
				}
			}
		}
		for _, child := range n.Content {
			if visit(child) {
				return true
			}
		}
		return false
	}
	return visit(node)
}
