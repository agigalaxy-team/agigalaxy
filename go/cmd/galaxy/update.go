package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
)

func updatePackageVersion(directory string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(directory, "native-v2.json"))
	if err != nil {
		return "", err
	}
	var manifest struct {
		ReleaseID string `json:"releaseId"`
	}
	if len(raw) > 1<<20 || json.Unmarshal(raw, &manifest) != nil {
		return "", fault.New("native_update_version_invalid", 409)
	}
	_, err = updateVersion(manifest.ReleaseID)
	return manifest.ReleaseID, err
}

func managedUpdate(ctx context.Context, input native.ManagedNativeInstallationInput, local, dryRun, restartLegacy bool, source updateSource) error {
	installed, err := native.ResolveManagedNativeMaintenance(input, nil)
	if err != nil {
		return err
	}
	if filepath.Clean(input.DataDirectory) != filepath.Clean(installed.DataDirectory) ||
		filepath.Clean(input.ConfigPath) != filepath.Clean(installed.ConfigPath) || input.LocalOnly != installed.LocalOnly {
		return fault.New("native_update_profile_changed", 409)
	}
	input.KeepIdentity = true
	previous, err := updatePackageVersion(installed.PackageDirectory)
	if err != nil {
		return err
	}
	var target string
	if local {
		target, err = updatePackageVersion(input.PackageDirectory)
	} else {
		target, err = source.latest(ctx)
	}
	if err != nil {
		return updateFailure("check_failed", target, err)
	}
	comparison, err := compareUpdateVersions(target, previous)
	if err != nil {
		return err
	}
	desired, desiredErr := nativebridge.GetDesiredRelease()
	if desiredErr != nil && !errors.Is(desiredErr, os.ErrNotExist) {
		return desiredErr
	}
	observed, statusErr := nativebridge.Status(ctx)
	if statusErr != nil && !errors.Is(statusErr, nativebridge.ErrUnavailable) && !errors.Is(statusErr, nativebridge.ErrPaused) {
		return statusErr
	}
	if comparison < 0 {
		return updateFailure("downgrade_blocked", target, fault.New("native_update_downgrade", 409))
	}
	for _, version := range []string{desired.ReleaseID, observed.ReleaseID} {
		if version == "" {
			continue
		}
		cmp, err := compareUpdateVersions(target, version)
		if err != nil {
			return err
		}
		if cmp < 0 {
			return updateFailure("downgrade_blocked", target, fault.New("native_update_downgrade", 409))
		}
	}
	result := map[string]any{"previousVersion": previous, "targetVersion": target, "runningVersion": observed.ReleaseID}
	if dryRun {
		result["updateState"] = "preview"
		result["upgradeAvailable"] = comparison > 0
		if local && comparison == 0 {
			result["localPackageCheckRequired"] = true
		}
		return printValue(result)
	}
	// A same-release OpenCode update still reconciles its selected host layout.
	if comparison == 0 && !local && input.Host == "opencode" {
		input.PackageDirectory = installed.PackageDirectory
		plan, e := native.PreviewManagedNativeInstallation(ctx, input)
		if e != nil {
			return e
		}
		applied, e := native.ApplyManagedNativeInstallation(ctx, plan)
		if e != nil {
			return updateFailure("installation_failed", target, e)
		}
		result["hostConfigured"] = applied["hostConfigured"]
	}
	if comparison == 0 && !local && observed.ReleaseID == target && observed.SwitchState == "current" {
		result["updateState"] = "up_to_date"
		return printValue(result)
	}
	if comparison == 0 && !local && desired.ReleaseID == target && (!errors.Is(statusErr, nativebridge.ErrPaused) || restartLegacy) {
		return activateUpdate(ctx, target, restartLegacy, result)
	}
	if comparison == 0 && !local && (desired.ReleaseID != "" || observed.ReleaseID != "") && desired.ReleaseID != target {
		name := "galaxy"
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		if _, err = nativebridge.SetDesiredRelease(filepath.Join(installed.PackageDirectory, name)); err != nil {
			return updateFailure("selection_failed", target, err)
		}
		return activateUpdate(ctx, target, restartLegacy, result)
	}
	if comparison == 0 && !local {
		result["updateState"] = "installed_not_running"
		return printValue(result)
	}
	if !local {
		directory, err := os.MkdirTemp("", "galaxy-verified-update-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(directory)
		if err = source.stage(ctx, target, directory); err != nil {
			return updateFailure("download_or_verification_failed", target, err)
		}
		version, err := updatePackageVersion(directory)
		if err != nil || version != target {
			return updateFailure("package_version_mismatch", target, fault.New("native_update_package_version_mismatch", 502))
		}
		input.PackageDirectory = directory
	}
	plan, err := native.PreviewManagedNativeInstallation(ctx, input)
	if err != nil {
		return err
	}
	installedResult, err := native.ApplyManagedNativeInstallation(ctx, plan)
	if err != nil {
		return updateFailure("installation_failed", target, err)
	}
	release, ok := installedResult["release"].(*native.NativeRelease)
	if !ok || release.ReleaseID != target || installedResult["hostConfigured"] != true {
		return fault.New("native_update_installation_incomplete", 409)
	}
	result["installedVersion"] = release.ReleaseID
	if _, err = nativebridge.SetDesiredRelease(release.Executable); err != nil {
		return updateFailure("selection_failed", target, err)
	}
	if current, statusErr := nativebridge.Status(ctx); statusErr == nil && current.SwitchState == "current" && current.ReleaseID == target {
		result["runningVersion"] = current.ReleaseID
		result["updateState"] = "up_to_date"
		return printValue(result)
	}
	return activateUpdate(ctx, target, restartLegacy, result)
}

func activateUpdate(ctx context.Context, target string, restartLegacy bool, result map[string]any) error {
	info, err := nativebridge.HandoverLocked(ctx)
	if restartLegacy && (fault.Code(err) == "native_handover_legacy_unsupported" || fault.Code(err) == "native_handover_legacy_connection") {
		if err = nativebridge.Stop(ctx); err == nil {
			startCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			info, err = nativebridge.EnsureLocked(startCtx, nativebridge.Options{ExplicitStart: true})
		}
	}
	if err == nil {
		info, err = nativebridge.Status(ctx)
		if err == nil && (info.ReleaseID != target || info.SwitchState != "current") {
			err = fault.New("native_update_running_version_mismatch", 409)
		}
	}
	if err != nil {
		result["updateState"] = "activation_pending"
		result["reason"] = fault.Code(err)
		switch fault.Code(err) {
		case "native_handover_legacy_unsupported", "native_handover_legacy_connection":
			result["nextAction"] = "Finish ongoing work and close old host connections, then run the update with --restart-legacy."
		default:
			result["nextAction"] = "Finish any pending confirmation or operation, then run the update again."
		}
		if current, statusErr := nativebridge.Status(ctx); statusErr == nil {
			result["runningVersion"] = current.ReleaseID
		} else {
			result["runningVersion"] = ""
		}
		if printErr := printValue(result); printErr != nil {
			return printErr
		}
		return err
	}
	result["updateState"] = "activated"
	result["runningVersion"] = info.ReleaseID
	return printValue(result)
}

func updateFailure(state, version string, err error) error {
	if printErr := printValue(map[string]any{"updateState": state, "targetVersion": version, "reason": err.Error()}); printErr != nil {
		return printErr
	}
	return err
}
