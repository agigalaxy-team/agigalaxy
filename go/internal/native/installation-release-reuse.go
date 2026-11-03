package native

import (
	"context"
	"crypto/sha256"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"

	"github.com/google/uuid"
)

type releaseTreeEntry struct {
	source     string
	directory  bool
	executable os.FileMode
}

// releaseExpectedTree models the existing copy and dependency-capture rules
// without copying bytes. It includes hoisted Node dependencies as well as all
// files already inside the release source.
func releaseExpectedTree(ctx context.Context, source string) (map[string]releaseTreeEntry, error) {
	entries := map[string]releaseTreeEntry{}
	var add func(string, string) error
	add = func(src, target string) error {
		if _, exists := entries[target]; exists {
			return hostConfigurationFailure("setup_dependency_invalid")
		}
		for parent := filepath.Dir(target); parent != "." && parent != ""; parent = filepath.Dir(parent) {
			if _, ok := entries[parent]; !ok {
				entries[parent] = releaseTreeEntry{directory: true}
			}
		}
		return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if err = ctx.Err(); err != nil {
				return err
			}
			rel, err := filepath.Rel(src, path)
			if err != nil {
				return err
			}
			dest := target
			if rel != "." {
				dest = filepath.Join(target, rel)
			}
			if releasePackagingMetadata(dest) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if d.Type()&os.ModeSymlink != 0 {
				return hostConfigurationFailure("setup_package_invalid")
			}
			if d.IsDir() {
				if old, ok := entries[dest]; ok && !old.directory {
					return hostConfigurationFailure("setup_package_invalid")
				}
				entries[dest] = releaseTreeEntry{directory: true}
				return nil
			}
			if !d.Type().IsRegular() {
				return hostConfigurationFailure("setup_package_invalid")
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			if _, exists := entries[dest]; exists {
				return hostConfigurationFailure("setup_dependency_invalid")
			}
			entries[dest] = releaseTreeEntry{source: path, executable: info.Mode().Perm() & 0100}
			return nil
		})
	}
	if err := add(source, "."); err != nil {
		return nil, err
	}
	var root installationDependency
	present, err := readJSON(filepath.Join(source, "package.json"), &root)
	if err != nil {
		return nil, err
	}
	if !present {
		return entries, nil
	}
	findInstalled := func(name, from string) (*installationDependency, error) {
		for current := filepath.Clean(from); ; current = filepath.Dir(current) {
			dir := filepath.Join(current, "node_modules", filepath.FromSlash(name))
			entry, ok := entries[filepath.Join(dir, "package.json")]
			if ok && !entry.directory {
				var pkg installationDependency
				present, e := readJSON(entry.source, &pkg)
				if e != nil {
					return nil, e
				}
				if !present || pkg.Name != name {
					return nil, hostConfigurationFailure("setup_dependency_invalid")
				}
				return &pkg, nil
			}
			if current == "." {
				return nil, nil
			}
			if filepath.Dir(current) == current {
				return nil, hostConfigurationFailure("setup_path_invalid")
			}
		}
	}
	seen := map[string]bool{}
	var capture func(string, string, string, bool, string) error
	capture = func(name, from, to string, optional bool, exact string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		dep, e := installationFindDependency(name, from)
		if e != nil {
			return e
		}
		if dep == nil {
			if optional {
				return nil
			}
			return hostConfigurationFailure("setup_dependency_missing")
		}
		if exact != "" && dep.Version != exact {
			return hostConfigurationFailure("setup_dependency_version")
		}
		found, e := findInstalled(name, to)
		if e != nil {
			return e
		}
		if found != nil && found.Version == dep.Version {
			return nil
		}
		target := filepath.Join(to, "node_modules", filepath.FromSlash(name))
		if seen[target] {
			return nil
		}
		seen[target] = true
		if e = add(dep.Directory, target); e != nil {
			return e
		}
		children := map[string]bool{}
		for child := range dep.Dependencies {
			children[child] = false
		}
		for child := range dep.Optional {
			children[child] = true
		}
		names := make([]string, 0, len(children))
		for child := range children {
			names = append(names, child)
		}
		sort.Strings(names)
		for _, child := range names {
			if e = capture(child, dep.Directory, target, children[child], ""); e != nil {
				return e
			}
		}
		return nil
	}
	names := make([]string, 0, len(root.Dependencies))
	for name := range root.Dependencies {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err = capture(name, source, ".", false, root.Dependencies[name]); err != nil {
			return nil, err
		}
	}
	return entries, nil
}

func releaseDigest(path string) ([32]byte, error) {
	var result [32]byte
	f, err := os.Open(path)
	if err != nil {
		return result, err
	}
	h := sha256.New()
	_, err = io.Copy(h, f)
	closeErr := f.Close()
	if err != nil {
		return result, err
	}
	if closeErr != nil {
		return result, closeErr
	}
	copy(result[:], h.Sum(nil))
	return result, nil
}
func releaseTreeMatches(ctx context.Context, root string, expected map[string]releaseTreeEntry, sourceDigests map[string][32]byte) (bool, error) {
	seen := map[string]bool{}
	match := true
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if releasePackagingMetadata(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		want, ok := expected[rel]
		if !ok || d.Type()&os.ModeSymlink != 0 || want.directory != d.IsDir() {
			match = false
			return filepath.SkipAll
		}
		seen[rel] = true
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			match = false
			return filepath.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode().Perm()&0100 != want.executable {
			match = false
			return filepath.SkipAll
		}
		digest, ok := sourceDigests[want.source]
		if !ok {
			digest, err = releaseDigest(want.source)
			if err != nil {
				return err
			}
			sourceDigests[want.source] = digest
		}
		actual, err := releaseDigest(path)
		if err != nil {
			return err
		}
		if actual != digest {
			match = false
			return filepath.SkipAll
		}
		return nil
	})
	if err != nil {
		return false, err
	}
	return match && len(seen) == len(expected), nil
}

// Only release directories referenced by current managed host records are
// eligible. A directory name alone does not establish installer ownership.
func findReusableNativeRelease(ctx context.Context, source, root, preferred string) (string, error) {
	if err := hostDirectory(root); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	records := filepath.Join(filepath.Dir(root), "hosts")
	items, err := os.ReadDir(records)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	paths := []string{}
	seen := map[string]bool{}
	for _, item := range items {
		if err = ctx.Err(); err != nil {
			return "", err
		}
		if item.IsDir() || item.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(item.Name(), ".json") {
			continue
		}
		path := filepath.Join(records, item.Name())
		if e := hostFile(path); e != nil {
			continue
		}
		var record managedNativeRecord
		present, e := readJSON(path, &record)
		if e != nil || !present || record.Version != 1 || record.ReleaseDirectory == "" {
			continue
		}
		candidate := filepath.Clean(record.ReleaseDirectory)
		if !installationSamePath(filepath.Dir(candidate), root) {
			continue
		}
		base := filepath.Base(candidate)
		if !strings.HasPrefix(base, "release-") {
			continue
		}
		if _, e = uuid.Parse(strings.TrimPrefix(base, "release-")); e != nil {
			continue
		}
		if !seen[candidate] {
			seen[candidate] = true
			paths = append(paths, candidate)
		}
	}
	if len(paths) == 0 {
		return "", nil
	}
	rank := func(path string) int {
		if preferred != "" && installationSamePath(path, preferred) {
			return 0
		}
		if installationSamePath(filepath.Dir(source), root) && installationSamePath(path, source) {
			return 1
		}
		return 2
	}
	sort.Slice(paths, func(i, j int) bool {
		a, b := rank(paths[i]), rank(paths[j])
		if a != b {
			return a < b
		}
		return paths[i] < paths[j]
	})
	expected, err := releaseExpectedTree(ctx, source)
	if err != nil {
		return "", err
	}
	digests := map[string][32]byte{}
	for _, path := range paths {
		info, e := os.Lstat(path)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		if _, e = hostCandidate(path); e != nil {
			continue
		}
		samePackage, e := releaseRuntimePackageMatches(source, path)
		if e != nil || !samePackage {
			continue
		}
		matched, e := releaseTreeMatches(ctx, path, expected, digests)
		if e != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			continue
		}
		if matched {
			return path, nil
		}
	}
	return "", nil
}

// npm rewrites the root package name, exports and lock bookkeeping when it
// installs the exact same platform payload. These files are not executed;
// semantic runtime fields are checked separately and all dependency payloads
// remain in the byte comparison.
func releasePackagingMetadata(rel string) bool {
	rel = filepath.ToSlash(filepath.Clean(rel))
	return rel == "package.json" || rel == "package-lock.json" || rel == "node_modules/.package-lock.json" || rel == "node_modules/.bin"
}
func releaseRuntimePackageMatches(a, b string) (bool, error) {
	type pkg struct {
		Version      string            `json:"version"`
		Type         string            `json:"type"`
		License      string            `json:"license"`
		Dependencies map[string]string `json:"dependencies"`
		Optional     map[string]string `json:"optionalDependencies"`
		Engines      map[string]string `json:"engines"`
		Exports      map[string]any    `json:"exports"`
	}
	read := func(root string) (pkg, error) {
		var p pkg
		present, err := readJSON(filepath.Join(root, "package.json"), &p)
		if err != nil {
			return p, err
		}
		if !present {
			return p, hostConfigurationFailure("setup_package_invalid")
		}
		delete(p.Exports, "./package.json")
		return p, nil
	}
	left, err := read(a)
	if err != nil {
		return false, err
	}
	right, err := read(b)
	if err != nil {
		return false, err
	}
	return reflect.DeepEqual(left, right), nil
}
