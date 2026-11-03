package native

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	yaml "go.yaml.in/yaml/v3"
)

func hermesInstallationSpec(input HostConfigurationInput) (map[string]any, error) {
	entry, err := hostCandidate(input.PackageDirectory)
	if err != nil {
		return nil, err
	}
	args, env := input.launch()
	mcp := map[string]any{"command": entry, "args": args}
	if len(env) > 0 {
		mcp["env"] = env
	}
	settings := map[string]any{"executable": entry}
	if input.LocalOnly {
		settings["data_directory"] = input.DataDirectory
	} else {
		settings["config"] = input.ConfigPath
	}
	raw, err := json.Marshal(map[string]any{"mcp": mcp, "settings": settings})
	if err != nil {
		return nil, err
	}
	var result map[string]any
	err = json.Unmarshal(raw, &result)
	return result, err
}

// yamlInherited resolves YAML merge precedence without modifying anchors.
// A local override is cloned only for the edited branch, leaving the anchor
// and every other inherited setting untouched.
func yamlInherited(node *yaml.Node, key string, seen map[*yaml.Node]bool) (*yaml.Node, error) {
	if node == nil {
		return nil, nil
	}
	if seen[node] {
		return nil, hostConfigurationFailure("setup_host_config_conflict")
	}
	seen[node] = true
	defer delete(seen, node)
	if node.Kind == yaml.AliasNode {
		return yamlInherited(node.Alias, key, seen)
	}
	if node.Kind == yaml.SequenceNode {
		for _, item := range node.Content {
			v, e := yamlInherited(item, key, seen)
			if e != nil || v != nil {
				return v, e
			}
		}
		return nil, nil
	}
	if node.Kind != yaml.MappingNode {
		return nil, hostConfigurationFailure("setup_host_config_conflict")
	}
	var merges []*yaml.Node
	var found *yaml.Node
	for i := 0; i < len(node.Content); i += 2 {
		k := node.Content[i]
		if k.Value == "<<" || k.Tag == "!!merge" {
			merges = append(merges, node.Content[i+1])
			continue
		}
		if k.Value == key {
			if found != nil {
				return nil, hostConfigurationFailure("setup_host_config_conflict")
			}
			found = node.Content[i+1]
		}
	}
	if found != nil {
		return found, nil
	}
	for _, m := range merges {
		v, e := yamlInherited(m, key, seen)
		if e != nil || v != nil {
			return v, e
		}
	}
	return nil, nil
}
func yamlClone(node *yaml.Node) *yaml.Node {
	// Resolve the edited alias itself, but retain aliases inside the cloned
	// subtree so they continue to refer to the original YAML anchors.
	seen := map[*yaml.Node]bool{}
	for node.Kind == yaml.AliasNode && node.Alias != nil && !seen[node] {
		seen[node] = true
		node = node.Alias
	}
	var copyTree func(*yaml.Node) *yaml.Node
	copyTree = func(n *yaml.Node) *yaml.Node {
		c := *n
		if n.Kind == yaml.AliasNode {
			return &c
		}
		c.Anchor = ""
		c.Content = make([]*yaml.Node, len(n.Content))
		for i, child := range n.Content {
			c.Content[i] = copyTree(child)
		}
		return &c
	}
	return copyTree(node)
}

func yamlPeek(parent *yaml.Node, key string) (*yaml.Node, error) {
	return yamlInherited(parent, key, map[*yaml.Node]bool{})
}
func yamlMapping(parent *yaml.Node, key string, create bool) (*yaml.Node, error) {
	if parent.Kind != yaml.MappingNode {
		return nil, hostConfigurationFailure("setup_host_config_conflict")
	}
	index := -1
	var merges []*yaml.Node
	for i := 0; i < len(parent.Content); i += 2 {
		k := parent.Content[i]
		if k.Value == "<<" || k.Tag == "!!merge" {
			merges = append(merges, parent.Content[i+1])
			continue
		}
		if k.Value == key {
			if index >= 0 {
				return nil, hostConfigurationFailure("setup_host_config_conflict")
			}
			index = i + 1
		}
	}
	var found *yaml.Node
	if index >= 0 {
		found = parent.Content[index]
		if found.Kind == yaml.AliasNode {
			found = yamlClone(found)
			parent.Content[index] = found
		}
	}
	if found == nil {
		for _, m := range merges {
			inherited, e := yamlInherited(m, key, map[*yaml.Node]bool{})
			if e != nil {
				return nil, e
			}
			if inherited != nil {
				found = yamlClone(inherited)
				parent.Content = append(parent.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, found)
				break
			}
		}
	}
	if found == nil && create {
		found = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		parent.Content = append(parent.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, found)
	}
	if found != nil && create && found.Kind == yaml.ScalarNode && found.Tag == "!!null" {
		found.Kind = yaml.MappingNode
		found.Tag = "!!map"
		found.Value = ""
	}
	return found, nil
}

func yamlOwned(parent *yaml.Node, key string, desired, prior any, remove bool) error {
	existing, err := yamlMapping(parent, key, false)
	if err != nil {
		return err
	}
	if existing != nil {
		var actual any
		if err = existing.Decode(&actual); err != nil {
			return hostConfigurationFailure("setup_host_config_invalid")
		}
		if !reflect.DeepEqual(actual, prior) {
			return hostConfigurationFailure("setup_host_config_conflict")
		}
	}
	if remove {
		if existing == nil {
			return nil
		}
		for i := 0; i < len(parent.Content); i += 2 {
			if parent.Content[i].Value == key {
				parent.Content = append(parent.Content[:i], parent.Content[i+2:]...)
				return nil
			}
		}
		return nil
	}
	var fresh yaml.Node
	if err = fresh.Encode(desired); err != nil {
		return err
	}
	if existing != nil {
		fresh.HeadComment = existing.HeadComment
		fresh.LineComment = existing.LineComment
		fresh.FootComment = existing.FootComment
		*existing = fresh
	} else {
		parent.Content = append(parent.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &fresh)
	}
	return nil
}
func hermesConfiguration(path string, spec, prior map[string]any, remove bool) error {
	raw, err := os.ReadFile(path)
	missing := os.IsNotExist(err)
	if err != nil && !missing {
		return err
	}
	if missing {
		raw = []byte("{}\n")
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
	if len(doc.Content) != 1 {
		return hostConfigurationFailure("setup_host_config_conflict")
	}
	root := doc.Content[0]
	servers, err := yamlMapping(root, "mcp_servers", !remove)
	if err != nil {
		return err
	}
	plugins, err := yamlMapping(root, "plugins", !remove)
	if err != nil {
		return err
	}
	var oldMCP, oldSettings any
	if prior != nil {
		oldMCP = prior["mcp"]
		oldSettings = prior["settings"]
	}
	if servers != nil {
		if err = yamlOwned(servers, "galaxy", spec["mcp"], oldMCP, remove); err != nil {
			return err
		}
	}
	if plugins != nil {
		enabled, e := yamlMapping(plugins, "enabled", !remove)
		if e != nil {
			return e
		}
		if enabled != nil {
			if enabled.Kind == yaml.MappingNode && len(enabled.Content) == 0 {
				enabled.Kind = yaml.SequenceNode
				enabled.Tag = "!!seq"
			}
			if enabled.Kind != yaml.SequenceNode {
				return hostConfigurationFailure("setup_host_config_conflict")
			}
			found := false
			next := []*yaml.Node{}
			for _, v := range enabled.Content {
				if v.Kind != yaml.ScalarNode {
					return hostConfigurationFailure("setup_host_config_conflict")
				}
				if v.Value == "galaxy-work" {
					if found {
						return hostConfigurationFailure("setup_host_config_conflict")
					}
					found = true
					if prior == nil && !remove {
						return hostConfigurationFailure("setup_host_config_conflict")
					}
					if remove {
						continue
					}
				}
				next = append(next, v)
			}
			if !remove && !found {
				next = append(next, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "galaxy-work"})
			}
			enabled.Content = next
		}
		disabled, e := yamlPeek(plugins, "disabled")
		if e != nil {
			return e
		}
		if disabled != nil && !remove {
			if disabled.Kind != yaml.SequenceNode {
				return hostConfigurationFailure("setup_host_config_conflict")
			}
			for _, v := range disabled.Content {
				if v.Value == "galaxy-work" {
					return hostConfigurationFailure("setup_host_config_conflict")
				}
			}
		}
		entries, e := yamlMapping(plugins, "entries", !remove)
		if e != nil {
			return e
		}
		if entries != nil {
			plugin, e := yamlMapping(entries, "galaxy-work", !remove)
			if e != nil {
				return e
			}
			if plugin != nil {
				if e = yamlOwned(plugin, "settings", spec["settings"], oldSettings, remove); e != nil {
					return e
				}
			}
		}
	}
	var output bytes.Buffer
	enc := yaml.NewEncoder(&output)
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
		return hostWriteNew(path, output.Bytes())
	}
	original := string(raw)
	return hostReplaceSelected(path, output.String(), &original)
}

func hermesHome(home string, env map[string]string) (string, error) {
	dir := env["HERMES_HOME"]
	if dir != "" {
		if !filepath.IsAbs(dir) {
			return "", hostConfigurationFailure("setup_path_invalid")
		}
		return filepath.Clean(dir), nil
	}
	dir = filepath.Join(home, ".hermes")
	raw, err := os.ReadFile(filepath.Join(dir, "active_profile"))
	if os.IsNotExist(err) {
		return dir, nil
	}
	if err != nil {
		return "", err
	}
	name := strings.TrimSpace(strings.TrimPrefix(string(raw), "\ufeff"))
	if name == "" || name == "default" {
		return dir, nil
	}
	if len(name) > 64 {
		return "", hostConfigurationFailure("setup_hermes_profile_invalid")
	}
	for i, c := range name {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || i > 0 && (c == '_' || c == '-')) {
			return "", hostConfigurationFailure("setup_hermes_profile_invalid")
		}
	}
	return filepath.Join(dir, "profiles", name), nil
}

// hermesConfigured checks only the Galaxy-owned nodes and never returns any
// unrelated configuration values to the caller.
func hermesConfigured(path string, spec map[string]any) (bool, error) {
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
	if len(doc.Content) != 1 {
		return false, hostConfigurationFailure("setup_host_config_conflict")
	}
	root := doc.Content[0]
	servers, err := yamlMapping(root, "mcp_servers", false)
	if err != nil || servers == nil {
		return false, err
	}
	mcp, err := yamlMapping(servers, "galaxy", false)
	if err != nil || mcp == nil {
		return false, err
	}
	var actual any
	if err = mcp.Decode(&actual); err != nil {
		return false, hostConfigurationFailure("setup_host_config_invalid")
	}
	if !reflect.DeepEqual(actual, spec["mcp"]) {
		return false, nil
	}
	plugins, err := yamlMapping(root, "plugins", false)
	if err != nil || plugins == nil {
		return false, err
	}
	enabled, err := yamlMapping(plugins, "enabled", false)
	if err != nil || enabled == nil {
		return false, err
	}
	found := false
	if enabled.Kind != yaml.SequenceNode {
		return false, hostConfigurationFailure("setup_host_config_conflict")
	}
	for _, n := range enabled.Content {
		if n.Value == "galaxy-work" {
			found = true
		}
	}
	if !found {
		return false, nil
	}
	entries, err := yamlMapping(plugins, "entries", false)
	if err != nil || entries == nil {
		return false, err
	}
	plugin, err := yamlMapping(entries, "galaxy-work", false)
	if err != nil || plugin == nil {
		return false, err
	}
	settings, err := yamlMapping(plugin, "settings", false)
	if err != nil || settings == nil {
		return false, err
	}
	actual = nil
	if err = settings.Decode(&actual); err != nil {
		return false, hostConfigurationFailure("setup_host_config_invalid")
	}
	return reflect.DeepEqual(actual, spec["settings"]), nil
}
