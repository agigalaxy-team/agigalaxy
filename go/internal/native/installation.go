package native

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type NativeInstallationInput struct {
	Website, Host, DataDirectory, Destination, PackageDirectory, OpenCodePath, OpenCodeConfigDirectory, DefaultOpenCodeConfigDirectory, SubjectType string
	LocalOnly                                                                                                                                       bool
}
type NativeInstallationPlan struct {
	LocalOnly               bool                   `json:"localOnly"`
	Website                 string                 `json:"website"`
	Endpoint                string                 `json:"endpoint"`
	Operator                *string                `json:"operator"`
	Host                    string                 `json:"host"`
	DataDirectory           string                 `json:"dataDirectory"`
	Destination             string                 `json:"destination"`
	PublicFingerprints      []PublicKeyFingerprint `json:"publicFingerprints"`
	HostConfigDirectory     *string                `json:"hostConfigDirectory"`
	NormalStartupConfigured bool                   `json:"normalStartupConfigured"`
	SubjectType             string                 `json:"subjectType"`
	input                   NativeInstallationInput
	service                 *ServiceConfigurationInspection
	scope                   ChoiceScope
}

func InstallationWebsiteOrigin(value string) (string, error) {
	parsed, e := url.Parse(value)
	if e != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Host == "" {
		return "", hostConfigurationFailure("setup_website_invalid")
	}
	origin := "https://" + strings.ToLower(parsed.Host)
	if strings.HasSuffix(origin, ":443") {
		origin = strings.TrimSuffix(origin, ":443")
	}
	if !serviceConfigurationOrigin(origin) {
		return "", hostConfigurationFailure("setup_website_invalid")
	}
	return origin, nil
}

var openCodeVersionPattern = regexp.MustCompile(`(?i)(?:opencode\s+v?)?(\d+)\.(\d+)\.(\d+)`)

// A detected executable decides the layout. Without one, inspect only the
// selected configuration; otherwise produce the current V2 form.
func DetectOpenCodeLayout(ctx context.Context, executable, directory string) (string, string, error) {
	if executable != "" {
		probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		raw, err := exec.CommandContext(probeCtx, executable, "--version").Output()
		if err == nil {
			match := openCodeVersionPattern.FindStringSubmatch(string(raw))
			if len(match) > 1 {
				if match[1] == "1" {
					return "v1", strings.TrimSpace(string(raw)), nil
				}
				if match[1] == "2" {
					return "v2", strings.TrimSpace(string(raw)), nil
				}
			}
		}
		if ctx.Err() != nil {
			return "", "", ctx.Err()
		}
	}
	files, err := hostSelectedConfigurations(directory, "opencode")
	if err != nil {
		return "", "", err
	}
	for _, f := range files {
		if f.missing {
			continue
		}
		value, e := hostConfigurationObject(f.text)
		if e != nil {
			return "", "", e
		}
		mcp := uploadObject(value["mcp"])
		if _, ok := mcp["servers"]; ok {
			return "v2", "", nil
		}
		if len(mcp) > 0 {
			return "v1", "", nil
		}
	}
	if _, err = os.Stat(filepath.Join(directory, "cli.json")); err == nil {
		return "v2", "", nil
	} else if !os.IsNotExist(err) {
		return "", "", err
	}
	if _, err = os.Stat(filepath.Join(directory, "tui.json")); err == nil {
		return "v1", "", nil
	} else if !os.IsNotExist(err) {
		return "", "", err
	}
	return "v2", "", nil
}

func FindOpenCodeExecutable(explicit, environmentPath string) (string, error) {
	candidates := []string{explicit}
	if explicit == "" {
		candidates = nil
		for _, directory := range filepath.SplitList(environmentPath) {
			if directory == "" {
				continue
			}
			if runtime.GOOS == "windows" {
				candidates = append(candidates, filepath.Join(directory, "opencode.exe"), filepath.Join(directory, "opencode2.exe"), filepath.Join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe"))
			} else {
				candidates = append(candidates, filepath.Join(directory, "opencode"), filepath.Join(directory, "opencode2"))
			}
		}
	}
	for _, path := range candidates {
		if !filepath.IsAbs(path) {
			continue
		}
		info, e := os.Stat(path)
		if e == nil && info.Mode().IsRegular() {
			return path, nil
		}
		if e != nil && !os.IsNotExist(e) {
			return "", e
		}
	}
	if explicit != "" {
		return "", hostConfigurationFailure("setup_opencode_not_found")
	}
	return "", nil
}

// The CLI supplies its environment/home metadata; core never discovers or
// opens another host profile while previewing an explicitly selected target.
func OpenCodeConfigurationDirectory(environment map[string]string, home string) (string, error) {
	directory := environment["OPENCODE_CONFIG_DIR"]
	if directory == "" {
		base := environment["XDG_CONFIG_HOME"]
		if base == "" {
			base = filepath.Join(home, ".config")
		}
		directory = filepath.Join(base, "opencode")
	}
	return filepath.Abs(directory)
}
func PreviewNativeInstallation(ctx context.Context, input NativeInstallationInput, options ServiceConfigurationOptions) (*NativeInstallationPlan, error) {
	valid := false
	label := ""
	for _, host := range HostConfigurationOptions() {
		if host["id"] == input.Host {
			valid = true
			label = host["label"]
		}
	}
	if !valid {
		return nil, hostConfigurationFailure("setup_host_invalid")
	}
	for _, path := range []string{input.DataDirectory, input.Destination, input.PackageDirectory} {
		if !filepath.IsAbs(path) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
	}
	if filepath.Clean(input.DataDirectory) == filepath.Clean(input.Destination) {
		return nil, hostConfigurationFailure("setup_path_invalid")
	}
	if input.SubjectType == "" {
		input.SubjectType = "person"
	}
	if !isOne(input.SubjectType, "person", "organization") {
		return nil, hostConfigurationFailure("setup_subject_type_invalid")
	}
	if _, e := hostCandidate(input.PackageDirectory); e != nil {
		return nil, e
	}
	var hostDirectory *string
	if input.Host == "opencode" {
		if !filepath.IsAbs(input.OpenCodeConfigDirectory) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
		hostDirectory = &input.OpenCodeConfigDirectory
		if e := hostFile(filepath.Join(input.PackageDirectory, "opencode.js")); e != nil {
			return nil, e
		}
		if e := hostDirectoryCheck(input.OpenCodeConfigDirectory); e != nil {
			return nil, e
		}
	}
	service := &ServiceConfigurationInspection{PublicFingerprints: []PublicKeyFingerprint{}}
	if input.LocalOnly {
		if input.Website != "" {
			return nil, hostConfigurationFailure("setup_configuration_conflict")
		}
	} else {
		website, e := InstallationWebsiteOrigin(input.Website)
		if e != nil {
			return nil, e
		}
		service, e = InspectServiceConfiguration(ctx, ServiceConfigurationRequest{Website: website}, options)
		if e != nil {
			return nil, e
		}
	}
	store, e := NewStore(input.DataDirectory, service.Endpoint)
	if e != nil {
		return nil, e
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	normal := hostDirectory != nil && input.DefaultOpenCodeConfigDirectory != "" && filepath.Clean(*hostDirectory) == filepath.Clean(input.DefaultOpenCodeConfigDirectory)
	return &NativeInstallationPlan{LocalOnly: input.LocalOnly, Website: service.Website, Endpoint: service.Endpoint, Operator: service.Operator, Host: label, DataDirectory: input.DataDirectory, Destination: input.Destination, PublicFingerprints: service.PublicFingerprints, HostConfigDirectory: hostDirectory, NormalStartupConfigured: normal, SubjectType: input.SubjectType, input: input, service: service, scope: scope}, nil
}
func hostDirectoryCheck(path string) error {
	e := hostDirectory(path)
	if os.IsNotExist(e) {
		return nil
	}
	return e
}

func installationPrepareLocal(ctx context.Context, store *Store, subject string, scope *ChoiceScope) (map[string]any, error) {
	var existing map[string]any
	e := store.With(ctx, false, func(dir string) error {
		if e := store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		snapshot, e := localSnapshotWithin(dir)
		if e != nil {
			return e
		}
		owner, e := store.ownerWithin(dir, "")
		if e != nil {
			return e
		}
		if owner != "" {
			local := uploadObject(snapshot["identity"])
			var kind any
			if local["id"] == owner {
				kind = local["subjectType"]
			}
			existing = map[string]any{"created": false, "identity": owner, "subjectType": kind, "existingIdentityPreserved": true}
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	if existing != nil {
		return existing, nil
	}
	result, e := store.Initialize(ctx, InitializationInput{InitializationPath: "personal-galaxy", SubjectType: subject}, true, scope)
	if e != nil {
		return nil, e
	}
	owner := text(result["identity"])
	e = store.With(ctx, true, func(dir string) error {
		current, e := store.ownerWithin(dir, owner)
		if e != nil {
			return e
		}
		if current != owner {
			return hostConfigurationFailure("native_choice_binding_changed")
		}
		return writeJSON(filepath.Join(dir, "opencode-local-preparation.json"), map[string]any{"version": 1, "deferred": false})
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"created": true, "identity": owner, "subjectType": subject, "existingIdentityPreserved": false}, nil
}
