package native

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

var installationDependencyName = regexp.MustCompile(`(?i)^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$`)

type installationDependency struct {
	Directory    string
	Name         string            `json:"name"`
	Version      string            `json:"version"`
	Dependencies map[string]string `json:"dependencies"`
	Optional     map[string]string `json:"optionalDependencies"`
}

func installationFindDependency(name, from string) (*installationDependency, error) {
	if !installationDependencyName.MatchString(name) {
		return nil, hostConfigurationFailure("setup_dependency_invalid")
	}
	for current := filepath.Clean(from); ; {
		directory := filepath.Join(current, "node_modules", filepath.FromSlash(name))
		info, e := os.Lstat(directory)
		if e == nil {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return nil, hostConfigurationFailure("setup_dependency_invalid")
			}
			var pkg installationDependency
			if _, e = readJSON(filepath.Join(directory, "package.json"), &pkg); e != nil {
				return nil, e
			}
			if pkg.Name != name {
				return nil, hostConfigurationFailure("setup_dependency_invalid")
			}
			pkg.Directory = directory
			return &pkg, nil
		}
		if !os.IsNotExist(e) {
			return nil, e
		}
		parent := filepath.Dir(current)
		if parent == current {
			return nil, nil
		}
		current = parent
	}
}
func installationCaptureDependencies(source, installed string) error {
	var pkg installationDependency
	present, e := readJSON(filepath.Join(source, "package.json"), &pkg)
	if e != nil || !present {
		return e
	}
	seen := map[string]bool{}
	var capture func(string, string, string, bool, string) error
	capture = func(name, from, to string, optional bool, exact string) error {
		source, e := installationFindDependency(name, from)
		if e != nil {
			return e
		}
		if source == nil {
			if optional {
				return nil
			}
			return hostConfigurationFailure("setup_dependency_missing")
		}
		if exact != "" && source.Version != exact {
			return hostConfigurationFailure("setup_dependency_version")
		}
		found, e := installationFindDependency(name, to)
		if e != nil {
			return e
		}
		if found != nil && found.Version == source.Version {
			relative, e := filepath.Rel(installed, found.Directory)
			if e == nil && !filepath.IsAbs(relative) && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
				return nil
			}
		}
		target := filepath.Join(to, "node_modules", filepath.FromSlash(name))
		if seen[target] {
			return nil
		}
		seen[target] = true
		if e = os.MkdirAll(filepath.Dir(target), 0700); e != nil {
			return e
		}
		if e = hostCopyTree(source.Directory, target); e != nil {
			return e
		}
		children := map[string]bool{}
		for child := range source.Dependencies {
			children[child] = false
		}
		for child := range source.Optional {
			children[child] = true
		}
		names := []string{}
		for child := range children {
			names = append(names, child)
		}
		sort.Strings(names)
		for _, child := range names {
			if e = capture(child, source.Directory, target, children[child], ""); e != nil {
				return e
			}
		}
		return nil
	}
	names := []string{}
	for name := range pkg.Dependencies {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if e = capture(name, source, installed, false, pkg.Dependencies[name]); e != nil {
			return e
		}
	}
	return nil
}
