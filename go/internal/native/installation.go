package native

import (
	"context"
	"github.com/google/uuid"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type NativeInstallationInput struct{ Website, Host, DataDirectory, Destination, PackageDirectory, OpenCodePath, OpenCodeConfigDirectory, DefaultOpenCodeConfigDirectory, SubjectType string }
type NativeInstallationPlan struct {
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
func FindOpenCodeExecutable(explicit, environmentPath string) (string, error) {
	candidates := []string{explicit}
	if explicit == "" {
		candidates = nil
		for _, directory := range filepath.SplitList(environmentPath) {
			if directory == "" {
				continue
			}
			if runtime.GOOS == "windows" {
				candidates = append(candidates, filepath.Join(directory, "opencode.exe"), filepath.Join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe"))
			} else {
				candidates = append(candidates, filepath.Join(directory, "opencode"))
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
	website, e := InstallationWebsiteOrigin(input.Website)
	if e != nil {
		return nil, e
	}
	service, e := InspectServiceConfiguration(ctx, ServiceConfigurationRequest{Website: website}, options)
	if e != nil {
		return nil, e
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
	return &NativeInstallationPlan{Website: service.Website, Endpoint: service.Endpoint, Operator: service.Operator, Host: label, DataDirectory: input.DataDirectory, Destination: input.Destination, PublicFingerprints: service.PublicFingerprints, HostConfigDirectory: hostDirectory, NormalStartupConfigured: normal, SubjectType: input.SubjectType, input: input, service: service, scope: scope}, nil
}
func hostDirectoryCheck(path string) error {
	e := hostDirectory(path)
	if os.IsNotExist(e) {
		return nil
	}
	return e
}

// PrepareNativeInstallationReviewed performs the existing local install only
// after the caller presents this exact plan. It never starts the host or binds
// a remote identity. Files in separate directories are not a global transaction.
func PrepareNativeInstallationReviewed(ctx context.Context, plan *NativeInstallationPlan, subject string, confirmed bool) (map[string]any, error) {
	if plan == nil || !confirmed {
		return map[string]any{"prepared": false, "canceled": true, "identityCreated": false, "connected": false, "actualSettingsModified": false}, nil
	}
	if subject == "" {
		subject = plan.input.SubjectType
	}
	if !isOne(subject, "person", "organization") {
		return nil, hostConfigurationFailure("setup_subject_type_invalid")
	}
	input := plan.input
	service := plan.service
	store, e := NewStore(input.DataDirectory, service.Endpoint)
	if e != nil {
		return nil, e
	}
	if e = store.With(ctx, false, func(dir string) error { return store.verifyChoiceWithin(dir, &plan.scope) }); e != nil {
		return nil, e
	}
	if _, e = hostCandidate(input.PackageDirectory); e != nil {
		return nil, e
	}
	executable := ""
	if input.Host == "opencode" {
		executable, e = FindOpenCodeExecutable(input.OpenCodePath, "")
		if e != nil {
			return nil, e
		}
	}
	if e = os.MkdirAll(filepath.Dir(input.Destination), 0700); e != nil {
		return nil, e
	}
	if e = os.Mkdir(input.Destination, 0700); e != nil {
		return nil, e
	}
	configPath := filepath.Join(input.Destination, "galaxy-public-config.json")
	raw, e := hostJSON(Configuration{Version: 2, Endpoint: service.Endpoint, Website: service.Website, DataDirectory: input.DataDirectory, TrustedKeys: service.TrustedKeys})
	if e != nil {
		return nil, e
	}
	if e = hostWriteNew(configPath, raw); e != nil {
		return nil, e
	}
	installedPackage := input.PackageDirectory
	if input.Host == "opencode" {
		installedPackage, e = installationCopyPackage(input.PackageDirectory, input.OpenCodeConfigDirectory)
		if e != nil {
			return nil, e
		}
	}
	generatedInput := HostConfigurationInput{PackageDirectory: installedPackage, ConfigPath: configPath, Destination: filepath.Join(input.Destination, "host-configs"), Hosts: []string{input.Host}, DataDirectory: input.DataDirectory, Endpoint: service.Endpoint}
	generated, e := GenerateHostConfigurations(ctx, generatedInput)
	if e != nil {
		return nil, e
	}
	var installed map[string]any
	var local map[string]any
	if input.Host == "opencode" {
		if e = store.With(ctx, false, func(dir string) error { return store.verifyChoiceWithin(dir, &plan.scope) }); e != nil {
			return nil, e
		}
		configPlan, e := PreviewOpenCodeConfiguration(ctx, input.OpenCodeConfigDirectory, generatedInput)
		if e != nil {
			return nil, e
		}
		installed, e = InstallOpenCodeConfigurationReviewed(ctx, configPlan, true)
		if e != nil {
			return nil, e
		}
		local, e = installationPrepareLocal(ctx, store, subject, &plan.scope)
		if e != nil {
			return nil, e
		}
	}
	var launcher, launchCommand any
	if input.Host == "opencode" && executable != "" {
		path := filepath.Join(input.Destination, "run-opencode.mjs")
		source := "import {spawn} from 'node:child_process';\nconst child=spawn(" + hostJSONString(executable) + ",process.argv.slice(2),{stdio:'inherit',windowsHide:true,env:{...process.env,OPENCODE_CONFIG_DIR:" + hostJSONString(input.OpenCodeConfigDirectory) + "}});\nchild.once('error',()=>{process.stderr.write('OpenCode could not start. Check that it is still installed at the selected location.\\n');process.exitCode=1;});\nchild.once('exit',code=>{process.exitCode=code??1;});\n"
		if e = hostWriteNew(path, []byte(source)); e != nil {
			return nil, e
		}
		launcher = path
		quoted := "'" + strings.ReplaceAll(path, "'", "'\"'\"'") + "'"
		if runtime.GOOS == "windows" {
			quoted = "'" + strings.ReplaceAll(path, "'", "''") + "'"
		}
		launchCommand = "node " + quoted
	}
	var hostConfig any
	if installed != nil {
		hostConfig = installed["directory"]
	}
	selectedSubject := any(subject)
	if local != nil {
		selectedSubject = local["subjectType"]
	}
	result := map[string]any{"prepared": true, "host": input.Host, "website": service.Website, "endpoint": service.Endpoint, "configPath": configPath, "packageDirectory": installedPackage, "dataDirectory": input.DataDirectory, "destination": input.Destination, "hostDirectory": generated["destination"], "launcher": launcher, "launchCommand": launchCommand, "openCodeInstalled": nil, "hostConfigDirectory": hostConfig, "normalStartupConfigured": plan.NormalStartupConfigured, "subjectType": selectedSubject, "identityCreated": local != nil && local["created"] == true, "existingIdentityPreserved": local != nil && local["existingIdentityPreserved"] == true, "connected": false, "actualSettingsModified": installed != nil, "publicConfigurationSha256": service.PublicConfigurationSHA256}
	if input.Host == "opencode" {
		result["openCodeInstalled"] = executable != ""
	}
	raw, e = hostJSON(result)
	if e != nil {
		return nil, e
	}
	if e = hostWriteNew(filepath.Join(input.Destination, "installation.json"), raw); e != nil {
		return nil, e
	}
	return result, nil
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
func installationCopyPackage(source, configurationDirectory string) (string, error) {
	if e := os.MkdirAll(configurationDirectory, 0700); e != nil {
		return "", e
	}
	if e := hostDirectory(configurationDirectory); e != nil {
		return "", e
	}
	root := filepath.Join(configurationDirectory, "galaxy-native")
	if e := os.MkdirAll(root, 0700); e != nil {
		return "", e
	}
	if e := hostDirectory(root); e != nil {
		return "", e
	}
	target := filepath.Join(root, "client-"+uuid.NewString())
	relative, e := filepath.Rel(source, target)
	if e != nil || relative == "." || (!strings.HasPrefix(relative, ".."+string(filepath.Separator)) && relative != ".." && !filepath.IsAbs(relative)) {
		return "", hostConfigurationFailure("setup_path_invalid")
	}
	if e = hostCopyTree(source, target); e != nil {
		return "", e
	}
	if e = installationCaptureDependencies(source, target); e != nil {
		return "", e
	}
	return target, nil
}
