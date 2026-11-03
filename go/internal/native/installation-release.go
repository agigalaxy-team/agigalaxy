package native

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/google/uuid"
)

// NativeRelease describes one immutable, complete installed candidate. The
// application data directory is deliberately outside this tree.
type NativeRelease struct {
	Directory  string `json:"directory"`
	Executable string `json:"executable"`
	ReleaseID  string `json:"releaseId"`
	TargetOS   string `json:"targetOS"`
	TargetArch string `json:"targetArch"`
	Reused     bool   `json:"reused"`
}

// InstallNativeRelease reuses a matching managed release or copies the complete
// package into a new user-owned release directory. It never replaces an
// executable that may be in use. A source in an npm cache is copied with its
// runtime resources and dependencies before host configuration can use it.
func InstallNativeRelease(ctx context.Context, source, root, dataDirectory string) (*NativeRelease, error) {
	return installNativeRelease(ctx, source, root, dataDirectory, "")
}
func installNativeRelease(ctx context.Context, source, root, dataDirectory, preferred string) (*NativeRelease, error) {
	for _, p := range []string{source, root, dataDirectory} {
		if !filepath.IsAbs(p) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
	}
	// Source may itself be an already installed release; only copying into
	// its own subtree would recurse. Data and release trees must be disjoint.
	if installationPathInside(source, root) || installationPathInside(dataDirectory, root) || installationPathInside(root, dataDirectory) {
		return nil, hostConfigurationFailure("setup_path_invalid")
	}
	var m struct {
		ReleaseID string `json:"releaseId"`
		Target    struct {
			OS   string `json:"goos"`
			Arch string `json:"goarch"`
		} `json:"target"`
		Artifacts map[string]string `json:"artifacts"`
	}
	if _, err := hostCandidate(source); err != nil {
		return nil, err
	}
	if ok, err := readJSON(filepath.Join(source, "native-v2.json"), &m); err != nil || !ok {
		if err != nil {
			return nil, err
		}
		return nil, hostConfigurationFailure("setup_package_invalid")
	}
	if m.ReleaseID == "" || m.Target.OS != runtime.GOOS || m.Target.Arch != runtime.GOARCH || len(m.Artifacts) == 0 {
		return nil, hostConfigurationFailure("setup_package_platform_mismatch")
	}
	if err := installationValidateReleaseArtifacts(ctx, source, m.Artifacts); err != nil {
		return nil, err
	}
	if existing, err := findReusableNativeRelease(ctx, source, root, preferred); err != nil {
		return nil, err
	} else if existing != "" {
		if err = installationValidateReleaseArtifacts(ctx, existing, m.Artifacts); err == nil {
			entry, e := hostCandidate(existing)
			if e == nil {
				return &NativeRelease{Directory: existing, Executable: entry, ReleaseID: m.ReleaseID, TargetOS: m.Target.OS, TargetArch: m.Target.Arch, Reused: true}, nil
			}
		}
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	if err := hostDirectory(root); err != nil {
		return nil, err
	}
	target := filepath.Join(root, "release-"+uuid.NewString())
	if err := hostCopyTree(source, target); err != nil {
		return nil, err
	}
	if err := installationCaptureDependencies(source, target); err != nil {
		return nil, err
	}
	// Validate the installed bytes before any host can point at this release.
	// The source may have changed while the tree was being copied.
	if err := installationValidateReleaseArtifacts(ctx, target, m.Artifacts); err != nil {
		return nil, err
	}
	executable, err := hostCandidate(target)
	if err != nil {
		return nil, err
	}
	return &NativeRelease{Directory: target, Executable: executable, ReleaseID: m.ReleaseID, TargetOS: m.Target.OS, TargetArch: m.Target.Arch}, nil
}

// DetectCurrentNativeHost uses only explicit execution-environment evidence.
// Existing directories are not evidence of the active host. Conflicting signals
// are returned to the caller for an explicit choice.
func DetectCurrentNativeHost(environment map[string]string) []string {
	found := []string{}
	add := func(id string, yes bool) {
		if yes {
			found = append(found, id)
		}
	}
	add("opencode", environment["OPENCODE"] != "")
	add("claude-code", environment["CLAUDECODE"] != "" || environment["CLAUDE_CODE_ENTRYPOINT"] != "")
	add("codex", environment["CODEX_THREAD_ID"] != "")
	add("cursor", strings.TrimSpace(environment["CURSOR_AGENT"]) != "" || environment["CURSOR_EXTENSION_HOST_ROLE"] == "agent-exec")
	add("deepseek-harness", environment["DSH_SHELL"] == "1" && environment["DSH_SESSION_ID"] != "")
	add("hermes", environment["HERMES_SESSION_ID"] != "")
	return found
}

func installationPathInside(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !filepath.IsAbs(rel) && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

func installationExecutable(path string) error {
	if !filepath.IsAbs(path) {
		return hostConfigurationFailure("setup_path_invalid")
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return hostConfigurationFailure("setup_host_executable_invalid")
	}
	return nil
}

func installationValidateReleaseArtifacts(ctx context.Context, source string, artifacts map[string]string) error {
	for name, expected := range artifacts {
		if err := ctx.Err(); err != nil {
			return err
		}
		path := filepath.Join(source, filepath.FromSlash(name))
		rel, err := filepath.Rel(source, path)
		if err != nil || rel == "." || rel == ".." || filepath.IsAbs(rel) || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return hostConfigurationFailure("setup_package_invalid")
		}
		if err = hostFile(path); err != nil {
			return err
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		h := sha256.New()
		_, err = io.Copy(h, file)
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if hex.EncodeToString(h.Sum(nil)) != expected {
			return hostConfigurationFailure("setup_package_integrity")
		}
	}
	return nil
}
