package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
)

func installationEnvironment() map[string]string {
	environment := make(map[string]string)
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if ok {
			environment[name] = value
		}
	}
	return environment
}

func defaultClientRoot(home string) string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "Galaxy", "client")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Galaxy", "client")
	default:
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			base = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(base, "galaxy", "client")
	}
}

// A repair from an older host must use the newer selected release's complete
// payload, not copy old host resources alongside the newer shared core.
func preferSelectedRelease(ctx context.Context, directory string) (string, error) {
	requested, err := updatePackageVersion(directory)
	if err != nil {
		return "", err
	}
	chosen := directory
	consider := func(version, executable string) error {
		if version == "" {
			return nil
		}
		comparison, err := compareUpdateVersions(version, requested)
		if err != nil {
			return err
		}
		if comparison <= 0 {
			return nil
		}
		if !filepath.IsAbs(executable) {
			return fault.New("native_release_pointer_unavailable", 409)
		}
		selectedDir := filepath.Dir(executable)
		actual, err := updatePackageVersion(selectedDir)
		if err != nil {
			return err
		}
		info, err := os.Stat(executable)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() || actual != version {
			return fault.New("native_release_pointer_unavailable", 409)
		}
		chosen, requested = selectedDir, version
		return nil
	}
	selected, err := nativebridge.GetDesiredRelease()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if err == nil {
		if err = consider(selected.ReleaseID, selected.Executable); err != nil {
			return "", err
		}
	}
	running, err := nativebridge.Status(ctx)
	if err != nil && !errors.Is(err, nativebridge.ErrUnavailable) && !errors.Is(err, nativebridge.ErrPaused) {
		return "", err
	}
	if err == nil {
		if err = consider(running.ReleaseID, running.Executable); err != nil {
			return "", err
		}
	}
	return chosen, nil
}

// Installation actions are explicit CLI requests. The same plan/apply methods
// are used by Agent-driven installation and manual execution.
func managedClientCommand(ctx context.Context, action string, args []string) error {
	input := native.ManagedNativeInstallationInput{SubjectType: "person"}
	flags := arguments(action)
	flags.StringVar(&input.Host, "host", "", "")
	flags.StringVar(&input.Home, "home", "", "")
	flags.StringVar(&input.PackageDirectory, "package-dir", "", "")
	flags.StringVar(&input.InstallRoot, "install-root", "", "")
	flags.StringVar(&input.DataDirectory, "data-dir", "", "")
	flags.StringVar(&input.ConfigPath, "config", os.Getenv("GALAXY_NATIVE_CONFIG"), "")
	flags.StringVar(&input.NodeExecutable, "node", "", "")
	flags.StringVar(&input.HostExecutable, "host-executable", "", "")
	flags.StringVar(&input.UserMCPPath, "mcp-config", "", "")
	flags.StringVar(&input.UserSkillPath, "skill-dir", "", "")
	flags.StringVar(&input.UserMCPFormat, "mcp-format", "", "")
	flags.BoolVar(&input.LocalOnly, "local-only", false, "")
	organization := flags.Bool("organization", false, "")
	dryRun := flags.Bool("dry-run", false, "")
	var restartLegacy bool
	if action == "update" {
		flags.BoolVar(&restartLegacy, "restart-legacy", false, "")
	}
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return fault.New("native_arguments_invalid", 400)
	}
	supplied := make(map[string]bool)
	flags.Visit(func(value *flag.Flag) { supplied[value.Name] = true })
	var err error
	if input.Home == "" {
		input.Home, err = os.UserHomeDir()
		if err != nil {
			return err
		}
	}
	input.Home, err = filepath.Abs(input.Home)
	if err != nil {
		return err
	}
	input.Environment = installationEnvironment()
	if input.Host == "" && (input.UserMCPPath != "" || input.UserSkillPath != "") {
		input.Host = "custom"
	}
	if input.Host == "" {
		detected := native.DetectCurrentNativeHost(input.Environment)
		if len(detected) == 1 {
			input.Host = detected[0]
		} else if len(detected) > 1 {
			if err := printValue(map[string]any{"detectedHosts": detected, "requiresHostSelection": true}); err != nil {
				return err
			}
		}
	}
	if input.Host == "" {
		return fault.New("setup_host_required", 400)
	}
	if input.InstallRoot == "" {
		input.InstallRoot = defaultClientRoot(input.Home)
	}
	input.InstallRoot, err = filepath.Abs(input.InstallRoot)
	if err != nil {
		return err
	}
	if action == "uninstall" {
		configPath := input.UserMCPPath
		if configPath == "" && input.Host != "custom" {
			configPath, _, err = native.NativeUserHostPaths(input.Host, input.Home, input.Environment)
			if err != nil {
				return err
			}
		}
		if *dryRun {
			return printValue(map[string]any{"action": "uninstall", "host": input.Host, "installRoot": input.InstallRoot, "hostConfigPath": configPath, "dataPreserved": true})
		}
		result, err := native.UninstallManagedNativeHostAt(ctx, input.InstallRoot, input.Host, configPath)
		if err != nil {
			return err
		}
		return printValue(result)
	}
	if !*dryRun {
		unlock, err := nativebridge.WaitUpdate(ctx)
		if err != nil {
			return err
		}
		defer unlock()
	}
	if action != "repair" && action != "update" && input.PackageDirectory == "" {
		input.PackageDirectory, err = candidateDirectory()
		if err != nil {
			return err
		}
		supplied["package-dir"] = true
	}
	resolved, resolveError := native.ResolveManagedNativeMaintenance(input, supplied)
	if resolveError == nil {
		input = resolved
	} else if action != "install" || fault.Code(resolveError) != "setup_installation_missing" {
		return resolveError
	}
	if input.PackageDirectory == "" {
		input.PackageDirectory, err = candidateDirectory()
		if err != nil {
			return err
		}
	}
	input.PackageDirectory, err = filepath.Abs(input.PackageDirectory)
	if err != nil {
		return err
	}
	if input.ConfigPath == "" {
		input.LocalOnly = true
	} else {
		if input.LocalOnly {
			return fault.New("setup_configuration_conflict", 400)
		}
		input.ConfigPath, err = filepath.Abs(input.ConfigPath)
		if err != nil {
			return err
		}
		configuration, err := native.ReadConfiguration(input.ConfigPath)
		if err != nil {
			return err
		}
		if input.DataDirectory == "" {
			input.DataDirectory = configuration.DataDirectory
		}
	}
	if input.DataDirectory == "" {
		input.DataDirectory = os.Getenv("GALAXY_DATA_DIR")
	}
	if input.DataDirectory == "" {
		input.DataDirectory = filepath.Join(input.Home, ".galaxy")
	}
	input.DataDirectory, err = filepath.Abs(input.DataDirectory)
	if err != nil {
		return err
	}
	if input.NodeExecutable == "" {
		input.NodeExecutable, _ = exec.LookPath("node")
	}
	if input.NodeExecutable != "" {
		input.NodeExecutable, err = filepath.Abs(input.NodeExecutable)
		if err != nil {
			return err
		}
	}
	if input.HostExecutable == "" {
		command := map[string]string{"codex": "codex", "claude-code": "claude"}[input.Host]
		if command != "" {
			input.HostExecutable, _ = exec.LookPath(command)
		}
	}
	if input.HostExecutable != "" {
		input.HostExecutable, err = filepath.Abs(input.HostExecutable)
		if err != nil {
			return err
		}
	}
	if *organization {
		input.SubjectType = "organization"
	}
	if action != "update" && !*dryRun {
		input.PackageDirectory, err = preferSelectedRelease(ctx, input.PackageDirectory)
		if err != nil {
			return err
		}
	}
	if action == "update" {
		return managedUpdate(ctx, input, supplied["package-dir"], *dryRun, restartLegacy, officialUpdateSource())
	}
	plan, err := native.PreviewManagedNativeInstallation(ctx, input)
	if err != nil {
		return err
	}
	if *dryRun {
		return printValue(plan)
	}
	result, applyError := native.ApplyManagedNativeInstallation(ctx, plan)
	return completeManagedInstallation(ctx, result, applyError, action == "install" && !input.LocalOnly, input.ConfigPath)
}

// The caller holds the update lock through installation and selection.
func completeManagedInstallation(ctx context.Context, result map[string]any, applyError error, connect bool, configPath string) error {
	if applyError == nil && result != nil {
		if release, ok := result["release"].(*native.NativeRelease); ok && result["hostConfigured"] == true {
			desired, changed, err := nativebridge.SelectDesiredRelease(release.Executable, false)
			if err != nil {
				result["serviceReleaseSelected"] = false
				applyError = err
			} else {
				selected := filepath.Clean(desired.Executable) == filepath.Clean(release.Executable)
				if runtime.GOOS == "windows" {
					selected = strings.EqualFold(filepath.Clean(desired.Executable), filepath.Clean(release.Executable))
				}
				result["serviceReleaseSelected"] = selected
				result["serviceReleaseChanged"] = changed
				result["installedService"] = desired
				running, statusErr := nativebridge.Status(ctx)
				switch {
				case statusErr == nil:
					result["service"] = running
					if running.SwitchState == "restart-required" {
						adopted, err := nativebridge.HandoverLocked(ctx)
						if err != nil {
							result["serviceAdoption"] = "pending"
							result["serviceAdoptionError"] = fault.Code(err)
							applyError = err
						} else {
							result["service"] = adopted
							result["serviceAdoption"] = "current"
						}
					} else if running.SwitchState == "current" {
						result["serviceAdoption"] = "current"
					} else {
						result["serviceAdoption"] = "pending"
						applyError = fault.New("native_release_pointer_unavailable", 409)
					}
				case errors.Is(statusErr, nativebridge.ErrPaused), errors.Is(statusErr, nativebridge.ErrUnavailable):
					result["serviceAdoption"] = "not-running"
				default:
					result["serviceAdoption"] = "unknown"
					applyError = statusErr
				}
			}
		}
	}
	if applyError == nil && connect && result != nil && result["releaseInstalled"] == true && result["hostConfigured"] == true {
		result["serviceConnection"] = "pending"
		_, err := nativebridge.EnsureLocked(ctx, nativebridge.Options{ExplicitStart: true})
		if err == nil {
			var connection any
			connection, err = nativebridge.ConnectService(ctx, nativebridge.Profile{ConfigurationPath: configPath})
			if err == nil {
				result["serviceConnection"] = "ready"
				result["connection"] = connection
			}
		}
		if err != nil {
			result["serviceConnectionError"] = fault.Code(err)
			applyError = err
		}
	}
	if result != nil {
		if humanOutput && applyError != nil {
			if result["releaseInstalled"] == true && result["hostConfigured"] == true && result["serviceConnection"] == "pending" {
				fmt.Fprintln(os.Stdout, "银河已安装，暂未连接服务。")
			} else if result["releaseInstalled"] == true && result["hostConfigured"] == true && result["serviceAdoption"] == "pending" {
				fmt.Fprintln(os.Stdout, "银河已安装，服务尚未完成切换。")
			} else {
				fmt.Fprintln(os.Stdout, "银河安装未完成。")
			}
		} else if err := printValue(result); err != nil {
			return err
		}
	}
	return applyError
}
