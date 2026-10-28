package runtimeconfig

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// GoCoreArtifact retains the builder's development-candidate metadata separately
// from Node service-release migrations. Inspecting it grants no deployment or
// schema-transition authority.
type GoCoreArtifact struct {
	Version              int    `json:"version"`
	Kind                 string `json:"kind"`
	Component            string `json:"component"`
	ReleaseID            string `json:"releaseId"`
	ConfigurationVersion string `json:"configurationVersion"`
	CreatedAt            string `json:"createdAt"`
	Backend              string `json:"backend"`
	Compiler             string `json:"compiler"`
	Target               struct {
		GOOS   string `json:"goos"`
		GOARCH string `json:"goarch"`
		CGO    *bool  `json:"cgo"`
	} `json:"target"`
	Entries                     map[string]string      `json:"entries"`
	Files                       map[string]ReleaseFile `json:"files"`
	EmbeddedResources           []string               `json:"embeddedResources"`
	Schema                      json.RawMessage        `json:"schema"`
	Native                      json.RawMessage        `json:"native"`
	Limitations                 []string               `json:"limitations"`
	PublicRelease               *bool                  `json:"publicRelease"`
	Deployed                    *bool                  `json:"deployed"`
	DefaultInstallationChanged  *bool                  `json:"defaultInstallationChanged"`
	MigrationComplete           *bool                  `json:"migrationComplete"`
	ContainsConfiguredAuthority *bool                  `json:"containsConfiguredAuthority"`
}

var goCoreCommands = [...]string{"galaxy-api", "galaxy-worker", "galaxy-information-worker", "galaxy-publisher", "galaxy-migrate", "galaxy-lifecycle"}

func explicitlyFalse(value *bool) bool { return value != nil && !*value }

// InspectGoCoreArtifact validates the actual build-go-core.mjs output and all
// inventoried bytes without running a candidate or interpreting it as a release.
func InspectGoCoreArtifact(directory, pin string) (*ServiceRelease, error) {
	if !filepath.IsAbs(directory) || !sha.MatchString(pin) {
		return nil, releaseMismatch("Pinned release directory and digest required")
	}
	raw, e := os.ReadFile(filepath.Join(directory, "go-core-artifact.json"))
	if e != nil {
		return nil, e
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != pin {
		return nil, releaseMismatch("Service release manifest mismatch")
	}
	var artifact GoCoreArtifact
	if e = json.Unmarshal(raw, &artifact); e != nil {
		return nil, e
	}
	if artifact.Version != 1 || artifact.Kind != "galaxy-go-core-local-candidate" || artifact.Component != "hub" || artifact.Backend != "go" || !ref.MatchString(artifact.ReleaseID) || !ref.MatchString(artifact.ConfigurationVersion) || artifact.Compiler == "" || !explicitlyFalse(artifact.Target.CGO) || !explicitlyFalse(artifact.PublicRelease) || !explicitlyFalse(artifact.Deployed) || !explicitlyFalse(artifact.DefaultInstallationChanged) || !explicitlyFalse(artifact.MigrationComplete) || !explicitlyFalse(artifact.ContainsConfiguredAuthority) {
		return nil, releaseMismatch("Invalid Go core candidate manifest")
	}
	if artifact.Target.GOOS != "windows" && artifact.Target.GOOS != "linux" && artifact.Target.GOOS != "darwin" || artifact.Target.GOARCH != "amd64" && artifact.Target.GOARCH != "arm64" {
		return nil, releaseMismatch("Invalid Go core candidate target")
	}
	ext := ""
	if artifact.Target.GOOS == "windows" {
		ext = ".exe"
	}
	for _, command := range goCoreCommands {
		if artifact.Entries[command] != command+ext {
			return nil, releaseMismatch("Invalid Go core candidate entries")
		}
	}
	for _, name := range artifact.Entries {
		if _, exists := artifact.Files[name]; !exists {
			return nil, releaseMismatch("Invalid service release files")
		}
	}
	if e = verifyReleaseFilesNamed(directory, artifact.Files, safeGoCoreFileName); e != nil {
		return nil, e
	}
	return &ServiceRelease{Version: artifact.Version, Kind: artifact.Kind, Component: artifact.Component, ReleaseID: artifact.ReleaseID, ConfigurationVersion: artifact.ConfigurationVersion, CreatedAt: artifact.CreatedAt, Entries: artifact.Entries, Files: artifact.Files, Directory: directory, ManifestSHA256: pin, FilesVerified: true, GoCandidate: &artifact}, nil
}

func inspectRuntimeRelease(directory, pin string) (*ServiceRelease, error) {
	// Existing Node manifests keep precedence and their original format checks.
	// A bad/mismatched configured manifest never falls through to another file.
	if _, e := os.Lstat(filepath.Join(directory, "service-release.json")); e == nil || !os.IsNotExist(e) {
		return InspectServiceRelease(directory, pin)
	}
	return InspectGoCoreArtifact(directory, pin)
}
func runtimeReleaseEntry(release *ServiceRelease, role, entryFile string) (string, bool) {
	if release.GoCandidate == nil {
		entry, ok := release.Entries[role]
		return entry, ok
	}
	artifact := release.GoCandidate
	if artifact.Target.GOOS != runtime.GOOS || artifact.Target.GOARCH != runtime.GOARCH {
		return "", false
	}
	candidates := map[string][]string{
		"api": {"galaxy-api"}, "worker": {"galaxy-worker", "galaxy-information-worker"}, "information-worker": {"galaxy-information-worker"},
		"publisher": {"galaxy-publisher"}, "content-publisher": {"galaxy-publisher"}, "migration": {"galaxy-migrate"}, "migrate": {"galaxy-migrate"}, "lifecycle": {"galaxy-lifecycle"},
	}
	actual, e := filepath.Abs(entryFile)
	if e != nil {
		return "", false
	}
	for _, command := range candidates[role] {
		entry := release.Entries[command]
		selected, e := filepath.Abs(filepath.Join(release.Directory, filepath.FromSlash(entry)))
		if e == nil && actual == selected {
			return entry, true
		}
	}
	return "", false
}

// The Go inventory includes original dependency paths such as module@version;
// unlike Node resource names they need not match its ASCII filename alphabet.
func safeGoCoreFileName(name string) bool {
	if name == "" || filepath.IsAbs(name) || strings.ContainsAny(name, "\\:") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}
