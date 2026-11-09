package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
)

// ManagedNativeInstallationInput is shared by interactive and noninteractive
// entry points. Host must be the one explicitly selected current user host.
type ManagedNativeInstallationInput struct {
	Host             string                  `json:"host"`
	OpenCodeLayout   string                  `json:"openCodeLayout,omitempty"`
	OpenCodeVersion  string                  `json:"openCodeVersion,omitempty"`
	UserMCPPath      string                  `json:"userMcpPath,omitempty"`
	UserSkillPath    string                  `json:"userSkillPath,omitempty"`
	UserMCPFormat    string                  `json:"userMcpFormat,omitempty"`
	Home             string                  `json:"home"`
	Environment      map[string]string       `json:"-"`
	PackageDirectory string                  `json:"packageDirectory"`
	InstallRoot      string                  `json:"installRoot"`
	DataDirectory    string                  `json:"dataDirectory"`
	ConfigPath       string                  `json:"configPath,omitempty"`
	Endpoint         string                  `json:"endpoint,omitempty"`
	LocalOnly        bool                    `json:"localOnly"`
	PendingWebsite   string                  `json:"pendingWebsite,omitempty"`
	SubjectType      string                  `json:"subjectType"`
	UploadPrivacy    *UploadPrivacySelection `json:"-"`
	NodeExecutable   string                  `json:"nodeExecutable,omitempty"`
	HostExecutable   string                  `json:"hostExecutable,omitempty"`
	KeepIdentity     bool                    `json:"-"`
}
type ManagedNativeInstallationPlan struct {
	Action               string `json:"action"`
	Host                 string `json:"host"`
	ConfigPath           string `json:"hostConfigPath"`
	SkillPath            string `json:"skillPath"`
	DataDirectory        string `json:"dataDirectory"`
	PreviousRelease      string `json:"previousRelease,omitempty"`
	PendingRecovery      bool   `json:"pendingRecovery"`
	HookRuntimeAvailable *bool  `json:"hookRuntimeAvailable,omitempty"`
	input                ManagedNativeInstallationInput
	prior                *managedNativeRecord
	recordPath           string
	recordOriginal       string
}
type managedNativeRecord struct {
	Version           int                     `json:"version"`
	Host              string                  `json:"host"`
	OpenCodeLayout    string                  `json:"openCodeLayout,omitempty"`
	OpenCodeVersion   string                  `json:"openCodeVersion,omitempty"`
	ConfigFormat      string                  `json:"configFormat,omitempty"`
	DataDirectory     string                  `json:"dataDirectory"`
	ConfigPath        string                  `json:"configPath,omitempty"`
	Endpoint          string                  `json:"endpoint,omitempty"`
	LocalOnly         bool                    `json:"localOnly"`
	PendingWebsite    string                  `json:"pendingWebsite,omitempty"`
	HostConfigPath    string                  `json:"hostConfigPath"`
	SkillPath         string                  `json:"skillPath,omitempty"`
	ReleaseDirectory  string                  `json:"releaseDirectory"`
	ManagedSpec       any                     `json:"managedSpec,omitempty"`
	ManagedPluginPath string                  `json:"managedPluginPath,omitempty"`
	CodexBlock        string                  `json:"codexBlock,omitempty"`
	HookPath          string                  `json:"hookPath,omitempty"`
	HookGroup         any                     `json:"hookGroup,omitempty"`
	HookPrevious      any                     `json:"hookPrevious,omitempty"`
	CodexHookTrust    []managedCodexHookTrust `json:"codexHookTrust,omitempty"`
	NodeExecutable    string                  `json:"nodeExecutable,omitempty"`
	HostExecutable    string                  `json:"hostExecutable,omitempty"`
}

// PreviewManagedNativeInstallation inspects only the chosen host and the
// managed record. It does not create an identity, start services, or write.
func PreviewManagedNativeInstallation(ctx context.Context, input ManagedNativeInstallationInput) (*ManagedNativeInstallationPlan, error) {
	for _, p := range []string{input.Home, input.PackageDirectory, input.InstallRoot, input.DataDirectory} {
		if !filepath.IsAbs(p) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
	}
	var hookRuntimeAvailable *bool
	if input.Host == "codex" || input.Host == "claude-code" {
		if input.NodeExecutable == "" {
			if path, e := exec.LookPath("node"); e == nil {
				if absolute, e := filepath.Abs(path); e == nil {
					input.NodeExecutable = absolute
				}
			}
		}
		available := input.NodeExecutable != "" && installationExecutable(input.NodeExecutable) == nil
		hookRuntimeAvailable = &available
		if !available {
			input.NodeExecutable = ""
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if _, err := hostCandidate(input.PackageDirectory); err != nil {
		return nil, err
	}
	if input.SubjectType == "" {
		input.SubjectType = "person"
	}
	if !isOne(input.SubjectType, "person", "organization") {
		return nil, hostConfigurationFailure("setup_subject_type_invalid")
	}
	if input.PendingWebsite != "" && !serviceConfigurationOrigin(input.PendingWebsite) {
		return nil, hostConfigurationFailure("setup_website_invalid")
	}
	if input.LocalOnly {
		if input.ConfigPath != "" || input.Endpoint != "" {
			return nil, hostConfigurationFailure("setup_configuration_conflict")
		}
	} else {
		if !filepath.IsAbs(input.ConfigPath) {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
		c, err := ReadConfiguration(input.ConfigPath)
		if err != nil {
			return nil, err
		}
		if filepath.Clean(c.DataDirectory) != filepath.Clean(input.DataDirectory) {
			return nil, hostConfigurationFailure("setup_configuration_conflict")
		}
		input.Endpoint = c.Endpoint
	}
	var config, skill string
	var err error
	if input.Host == "custom" {
		config = input.UserMCPPath
		skill = input.UserSkillPath
		if !filepath.IsAbs(config) || !filepath.IsAbs(skill) || managedCustomAdapter(input.UserMCPFormat) == "" {
			return nil, hostConfigurationFailure("setup_path_invalid")
		}
	} else {
		config, skill, err = NativeUserHostPaths(input.Host, input.Home, input.Environment)
		if err != nil {
			return nil, err
		}
	}
	if input.Host == "opencode" {
		if input.HostExecutable == "" {
			input.HostExecutable, err = FindOpenCodeExecutable("", input.Environment["PATH"])
			if err != nil {
				return nil, err
			}
		}
		input.OpenCodeLayout, input.OpenCodeVersion, err = DetectOpenCodeLayout(ctx, input.HostExecutable, config)
		if err != nil {
			return nil, err
		}
	}
	recordPath, err := managedRecordPath(input.InstallRoot, input.Host, config)
	if err != nil {
		return nil, err
	}
	var prior managedNativeRecord
	present, err := readJSON(recordPath, &prior)
	if err != nil {
		return nil, err
	}
	plan := &ManagedNativeInstallationPlan{HookRuntimeAvailable: hookRuntimeAvailable, Action: "install", Host: input.Host, ConfigPath: config, SkillPath: skill, DataDirectory: input.DataDirectory, input: input, recordPath: recordPath}
	if _, e := os.Lstat(recordPath + ".pending"); e == nil {
		plan.PendingRecovery = true
		plan.Action = "recover"
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	if present {
		if err = hostFile(recordPath); err != nil {
			return nil, err
		}
		raw, e := os.ReadFile(recordPath)
		if e != nil {
			return nil, e
		}
		plan.recordOriginal = string(raw)
		if prior.Version != 1 || prior.Host != input.Host || !installationSamePath(prior.HostConfigPath, config) || input.Host == "custom" && prior.ConfigFormat != input.UserMCPFormat {
			return nil, hostConfigurationFailure("setup_existing_installation_conflict")
		}
		if !plan.PendingRecovery {
			plan.Action = "update-or-repair"
		}
		plan.PreviousRelease = prior.ReleaseDirectory
		plan.prior = &prior
	}
	return plan, nil
}

// ApplyManagedNativeInstallation installs an immutable complete release then
// switches the selected host. Prior release files and all data remain intact.
// Returned phases distinguish copied assets from actual host configuration.
func ApplyManagedNativeInstallation(ctx context.Context, plan *ManagedNativeInstallationPlan) (map[string]any, error) {
	if plan == nil {
		return nil, hostConfigurationFailure("setup_path_invalid")
	}
	input := plan.input
	if plan.PendingRecovery {
		if err := recoverManagedNativeInstallation(plan.recordPath); err != nil {
			return map[string]any{"recoveryJournal": plan.recordPath + ".pending"}, err
		}
		fresh, err := PreviewManagedNativeInstallation(ctx, input)
		if err != nil {
			return nil, err
		}
		return ApplyManagedNativeInstallation(ctx, fresh)
	}
	if plan.prior == nil {
		if _, err := os.Lstat(plan.recordPath); err == nil || !os.IsNotExist(err) {
			return nil, hostConfigurationFailure("setup_host_config_changed")
		}
	} else {
		raw, err := os.ReadFile(plan.recordPath)
		if err != nil || string(raw) != plan.recordOriginal {
			return nil, hostConfigurationFailure("setup_host_config_changed")
		}
	}
	if !managedDataOutsideInstall(input.DataDirectory, input.InstallRoot) {
		return nil, hostConfigurationFailure("setup_path_invalid")
	}
	identity, err := managedPrepareIdentity(ctx, input)
	if err != nil {
		return nil, err
	}
	preferred := ""
	if plan.prior != nil {
		preferred = plan.prior.ReleaseDirectory
	}
	release, err := installNativeRelease(ctx, input.PackageDirectory, filepath.Join(input.InstallRoot, "releases"), input.DataDirectory, preferred)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"release": release, "host": input.Host, "dataDirectory": input.DataDirectory, "releaseInstalled": true, "releaseReused": release.Reused, "hostConfigured": false, "hostRuntimeTested": false, "dataPreserved": true, "identity": identity}
	launch := HostConfigurationInput{OpenCodeLayout: input.OpenCodeLayout, LocalOnly: input.LocalOnly, PackageDirectory: release.Directory, ConfigPath: input.ConfigPath, DataDirectory: input.DataDirectory, Endpoint: input.Endpoint}
	next := managedNativeRecord{Version: 1, Host: input.Host, OpenCodeLayout: input.OpenCodeLayout, OpenCodeVersion: input.OpenCodeVersion, DataDirectory: input.DataDirectory, ConfigPath: input.ConfigPath, Endpoint: input.Endpoint, LocalOnly: input.LocalOnly, PendingWebsite: input.PendingWebsite, HostConfigPath: plan.ConfigPath, SkillPath: plan.SkillPath, ReleaseDirectory: release.Directory, ConfigFormat: input.UserMCPFormat}
	// The journal records the intended host state before the first host write.
	adapter := input.Host
	if input.Host == "custom" {
		adapter = managedCustomAdapter(input.UserMCPFormat)
	}
	if isOne(adapter, "claude-code", "cursor", "github-copilot", "github-copilot-cli", "custom-json-mcpServers", "custom-json-servers") {
		entry, e := hostCandidate(release.Directory)
		if e != nil {
			return result, e
		}
		args, env := launch.launch()
		b, e := json.Marshal(managedUserMCPSpec(adapter, entry, args, env))
		if e != nil {
			return result, e
		}
		if e = json.Unmarshal(b, &next.ManagedSpec); e != nil {
			return result, e
		}
	}
	if input.Host == "deepseek-harness" {
		var e error
		next.ManagedSpec, e = dshInstallationSpec(launch)
		if e != nil {
			return result, e
		}
	}
	if input.Host == "hermes" {
		var e error
		next.ManagedSpec, e = hermesInstallationSpec(launch)
		if e != nil {
			return result, e
		}
		next.ManagedPluginPath = filepath.Join(filepath.Dir(plan.ConfigPath), "plugins", "galaxy-work")
	}
	if input.Host == "codex" || adapter == "custom-toml" {
		var e error
		next.CodexBlock, e = managedCodexBlock(launch)
		if e != nil {
			return result, e
		}
	}
	if input.Host == "opencode" {
		next.HostExecutable = input.HostExecutable
		var e error
		next.ManagedSpec, e = managedOpenCodeSpec(&next)
		if e != nil {
			return result, e
		}
	}
	if plan.prior != nil {
		next.HookGroup = plan.prior.HookGroup
		next.HookPrevious = plan.prior.HookPrevious
		next.HookPath = plan.prior.HookPath
		next.NodeExecutable = plan.prior.NodeExecutable
		if next.HostExecutable == "" {
			next.HostExecutable = plan.prior.HostExecutable
		}
		next.CodexHookTrust = plan.prior.CodexHookTrust
	}
	baseline, e := managedNativeBaseline(&next)
	if e != nil {
		return result, e
	}
	journal := managedNativeJournal{Version: 1, Target: next, Prior: plan.prior, PriorRaw: plan.recordOriginal, Baseline: baseline}
	journalBytes, e := hostJSON(journal)
	if e != nil {
		return result, e
	}
	if e = hostWriteNew(plan.recordPath+".pending", journalBytes); e != nil {
		return result, e
	}
	result["recoveryJournal"] = plan.recordPath + ".pending"
	priorSkill := ""
	if plan.prior != nil && installationSamePath(plan.prior.SkillPath, plan.SkillPath) {
		priorSkill = filepath.Join(plan.prior.ReleaseDirectory, "skills", "galaxy")
	}
	switch adapter {
	case "claude-code", "cursor", "github-copilot", "github-copilot-cli", "custom-json-mcpServers", "custom-json-servers":
		var priorSpec any
		if plan.prior != nil {
			priorSpec = plan.prior.ManagedSpec
		}
		hostPlan, e := PreviewUserHostConfiguration(ctx, adapter, plan.ConfigPath, plan.SkillPath, launch, priorSpec, priorSkill)
		if e != nil {
			return result, e
		}
		configured, e := InstallUserHostConfiguration(ctx, hostPlan)
		if e != nil {
			return result, e
		}
		next.ManagedSpec = configured["managedMcpSpec"]
	case "codex", "custom-toml":
		old := ""
		if plan.prior != nil {
			old = plan.prior.CodexBlock
		}
		err = installationReplaceSkill(plan.SkillPath, filepath.Join(release.Directory, "skills", "galaxy"), priorSkill, func() error {
			var e error
			next.CodexBlock, e = UpdateCodexNativeConfiguration(plan.ConfigPath, launch, old)
			return e
		})
		if err != nil {
			return result, err
		}
	case "deepseek-harness":
		var priorSpec map[string]any
		if plan.prior != nil {
			priorSpec, _ = plan.prior.ManagedSpec.(map[string]any)
		}
		spec, _ := next.ManagedSpec.(map[string]any)
		err = installationReplaceSkill(plan.SkillPath, filepath.Join(release.Directory, "skills", "galaxy"), priorSkill, func() error { return dshPatch(plan.ConfigPath, spec, priorSpec, false) })
		if err != nil {
			return result, err
		}
		result["observationPluginConfigured"] = true
	case "hermes":
		var priorSpec map[string]any
		priorPlugin := ""
		if plan.prior != nil {
			priorSpec, _ = plan.prior.ManagedSpec.(map[string]any)
			priorPlugin = filepath.Join(plan.prior.ReleaseDirectory, "host-adapters", "hermes")
		}
		spec, _ := next.ManagedSpec.(map[string]any)
		err = installationReplaceSkill(plan.SkillPath, filepath.Join(release.Directory, "skills", "galaxy"), priorSkill, func() error {
			return installationReplaceHermesPlugin(next.ManagedPluginPath, filepath.Join(release.Directory, "host-adapters", "hermes"), priorPlugin, func() error { return hermesConfiguration(plan.ConfigPath, spec, priorSpec, false) })
		})
		if err != nil {
			return result, err
		}
		result["pluginConfigured"] = true
	case "opencode":
		if plan.prior != nil {
			launch.OpenCodePriorSpec = plan.prior.ManagedSpec
			launch.OpenCodePriorLayout = plan.prior.OpenCodeLayout
		}
		if err = managedOpenCodeCheck(plan.ConfigPath, plan.prior); err != nil {
			return result, err
		}
		hostPlan, e := PreviewOpenCodeConfiguration(ctx, plan.ConfigPath, launch)
		if e != nil {
			return result, e
		}
		_, e = InstallOpenCodeConfigurationReviewed(ctx, hostPlan, true)
		if e != nil {
			return result, e
		}
	default:
		return result, hostConfigurationFailure("setup_host_user_scope_unsupported")
	}
	result["hostConfigured"] = true
	result["mcpConfigured"] = true
	result["skillInstalled"] = true
	if !isOne(input.Host, "opencode", "codex", "claude-code", "hermes", "deepseek-harness") {
		result["observationStatus"] = "not-configured"
	}
	var old, older any
	if plan.prior != nil {
		old = plan.prior.HookGroup
		older = plan.prior.HookPrevious
		next.HookPath = plan.prior.HookPath
		next.NodeExecutable = plan.prior.NodeExecutable
		if next.HostExecutable == "" {
			next.HostExecutable = plan.prior.HostExecutable
		}
	}
	hookReady := false
	if input.Host == "codex" || input.Host == "claude-code" {
		result["hooksConfigured"] = false
		if input.Host == "codex" {
			next.HookPath = filepath.Join(filepath.Dir(plan.ConfigPath), "hooks.json")
		} else {
			next.HookPath = filepath.Join(filepath.Dir(filepath.Dir(plan.SkillPath)), "settings.json")
		}
		next.NodeExecutable = input.NodeExecutable
		next.HostExecutable = input.HostExecutable
		if input.NodeExecutable != "" {
			var hookErr error
			next.HookGroup, hookErr = managedHookGroup(input.Host, input.NodeExecutable, release.Directory, input.ConfigPath, input.DataDirectory)
			if hookErr == nil {
				hookReady = true
				next.HookPrevious = old
			} else {
				next.HookGroup = old
				next.HookPrevious = older
				result["hookStatus"] = "unavailable"
				result["hookError"] = installationOptionalFailure(hookErr)
			}
		} else {
			next.HookGroup = old
			next.HookPrevious = older
			result["hookStatus"] = "node-unavailable"
		}
	}

	if input.Host == "codex" && plan.prior != nil && len(plan.prior.CodexHookTrust) > 0 && (!hookReady || !reflect.DeepEqual(old, next.HookGroup)) {
		remaining, cleanupErr := clearCodexHookTrust(ctx, input.HostExecutable, plan.prior)
		next.CodexHookTrust = remaining
		if cleanupErr != nil {
			result["hookTrustCleanup"] = "retained"
		} else {
			result["hookTrustCleanup"] = "removed"
		}
	}

	raw, err := hostJSON(next)
	if err != nil {
		return result, err
	}
	if plan.prior == nil {
		err = hostWriteNew(plan.recordPath, raw)
	} else {
		err = hostReplaceSelected(plan.recordPath, string(raw), &plan.recordOriginal)
	}
	if err != nil {
		return result, err
	}
	result["recordPath"] = plan.recordPath
	if err = os.Remove(plan.recordPath + ".pending"); err != nil {
		return result, err
	}
	delete(result, "recoveryJournal")
	if hookReady {
		if older != nil && !reflect.DeepEqual(older, old) {
			if e := removeManagedHooks(input.Host, next.HookPath, older); e != nil {
				result["hookStatus"] = "failed"
				result["hookError"] = installationOptionalFailure(e)
				return result, nil
			}
		}
		if e := managedHooks(input.Host, next.HookPath, next.HookGroup, old, older); e != nil {
			result["hookStatus"] = "failed"
			result["hookError"] = installationOptionalFailure(e)
			return result, nil
		}
		result["hooksConfigured"] = true
		result["hookStatus"] = "configured"
		next.HookPrevious = nil
		final, e := hostJSON(next)
		if e != nil {
			return result, e
		}
		priorText := string(raw)
		if e = hostReplaceSelected(plan.recordPath, string(final), &priorText); e != nil {
			return result, e
		}
		if input.Host == "codex" {
			var tracked []managedCodexHookTrust
			status, trustErr := adoptCodexHooks(ctx, input.HostExecutable, next.HookPath, next.HookGroup, next.CodexHookTrust, &tracked)
			result["hookStatus"] = status
			if status != "trusted" {
				result["hookTrustHelp"] = "Codex /hooks or Desktop Settings > Hooks"
			}
			if trustErr != nil {
				result["hookError"] = "codex_hook_trust_unavailable"
			}
			if status == "trusted" || len(tracked) > 0 {
				for _, oldTrust := range next.CodexHookTrust {
					found := false
					for _, current := range tracked {
						if oldTrust.Key == current.Key {
							found = true
							break
						}
					}
					if !found {
						tracked = append(tracked, oldTrust)
					}
				}
				next.CodexHookTrust = tracked
				if updated, e := hostJSON(next); e == nil {
					previous := string(final)
					if e = hostReplaceSelected(plan.recordPath, string(updated), &previous); e == nil {
						result["hookTrustRecordSaved"] = true
					} else {
						result["hookTrustRecordSaved"] = false
					}
				} else {
					result["hookTrustRecordSaved"] = false
				}
			}
		}
	} else if input.Host == "codex" || input.Host == "claude-code" {
		result["hooksConfigured"] = false
		// Remove only our previously recorded hook if it cannot follow the newly
		// selected data/profile; retain it and report the failure if removal fails.
		if old != nil || older != nil {
			var removal error
			for _, group := range []any{old, older} {
				if group != nil {
					if e := removeManagedHooks(input.Host, next.HookPath, group); e != nil {
						removal = e
						break
					}
				}
			}
			if removal != nil {
				result["hookStatus"] = "previous-hook-retained"
				result["hookError"] = installationOptionalFailure(removal)
			} else {
				next.HookGroup = nil
				next.HookPrevious = nil
				final, e := hostJSON(next)
				if e != nil {
					return result, e
				}
				priorText := string(raw)
				if e = hostReplaceSelected(plan.recordPath, string(final), &priorText); e != nil {
					return result, e
				}
			}
		}
	}

	return result, nil
}

func installationOptionalFailure(err error) string {
	if os.IsPermission(err) {
		return "permission_denied"
	}
	if os.IsNotExist(err) {
		return "resource_missing"
	}
	return fault.Code(err)
}
