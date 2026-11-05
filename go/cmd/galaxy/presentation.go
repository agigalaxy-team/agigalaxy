package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/native"
	"github.com/agigalaxy-team/agigalaxy/go/internal/nativebridge"
)

// Maintenance output is concise on a terminal. Pipes retain the established
// JSON contract, and --json explicitly selects it even on a terminal.
func printHumanValue(value any) error {
	message := "结果尚未确认。"
	switch result := value.(type) {
	case *native.ManagedNativeInstallationPlan:
		message = "已完成安装检查，尚未应用更改。"
		if result.PendingRecovery {
			message += " 发现需要恢复的上次安装操作。"
		}
	case nativebridge.Info:
		if outputAction == "service" && result.InstanceID != "" {
			message = "银河服务正在运行。"
			if result.ReleaseID != "" {
				message += " 运行版本：" + result.ReleaseID + "。"
			}
		}
	case map[string]any:
		if result["requiresHostSelection"] == true {
			if hosts, ok := result["detectedHosts"].([]string); ok && len(hosts) > 0 {
				message = "检测到多个宿主，请选择当前宿主：" + strings.Join(hosts, "、") + "。"
			} else {
				message = "请选择当前宿主。"
			}
		} else if state, ok := result["updateState"].(string); ok {
			message = humanUpdateState(state, result)
		} else if outputAction == "service" {
			if result["handoverError"] != nil {
				message = "服务尚未完成切换。"
				switch result["handoverError"] {
				case "native_handover_legacy_unsupported", "native_handover_legacy_connection":
					message += " 请完成当前工作后停止并重新启动服务；现有连接会关闭。"
				case "native_handover_waiting_choice":
					message += " 请先完成当前选择，再重试。"
				}
			} else if running, ok := result["running"].(bool); ok {
				if running {
					message = "银河服务正在运行。"
				} else {
					message = "银河服务未运行。"
				}
			}
			if info, ok := result["service"].(nativebridge.Info); ok && info.ReleaseID != "" {
				message += " 运行版本：" + info.ReleaseID + "。"
			}
		} else if outputAction == "uninstall" && outputDryRun && result["action"] == "uninstall" {
			message = "已完成移除检查，尚未应用更改。"
		} else if outputAction == "uninstall" && result["hostConfigured"] == false {
			message = "已移除当前宿主的银河接入。"
			if result["dataPreserved"] == true {
				message += " 本地资料已保留。"
			}
		} else if (outputAction == "setup" || outputAction == "install" || outputAction == "repair") && result["releaseInstalled"] == true && result["hostConfigured"] == true {
			message = "银河客户端和当前宿主的接入配置已准备。"
			if release, ok := result["release"].(*native.NativeRelease); ok && release.ReleaseID != "" {
				message += " 客户端版本：" + release.ReleaseID + "。"
			}
			if result["serviceReleaseSelected"] == false {
				message += " 已沿用原先选定的共享服务版本。"
			}
		} else if result["recoveryJournal"] != nil {
			message = "操作未完成，需要处理上次操作的恢复记录。"
		}
	}
	_, err := fmt.Fprintln(os.Stdout, message)
	return err
}

func humanUpdateState(state string, result map[string]any) string {
	message := "更新结果尚未确认。"
	switch state {
	case "preview":
		if available, ok := result["upgradeAvailable"].(bool); ok {
			if result["localPackageCheckRequired"] == true {
				message = "版本相同；应用时将检查并安装所选包。"
			} else if available {
				message = "发现可用更新，尚未应用。"
			} else {
				message = "所检查的版本没有比已安装版本更新。"
			}
		}
	case "up_to_date":
		message = "所检查的版本已安装并运行。"
	case "activated":
		message = "客户端已切换到所检查的版本。"
	case "installed_not_running":
		message = "所检查的版本已安装，服务尚未运行。"
	case "activation_pending":
		message = "所检查的版本已安装，尚未完成切换。"
		if result["reason"] == "native_handover_legacy_unsupported" || result["reason"] == "native_handover_legacy_connection" {
			message += " 请完成当前工作、关闭旧宿主连接后，使用 update --restart-legacy 再次更新。"
		} else {
			message += ""
		}
	case "check_failed", "downgrade_blocked", "download_or_verification_failed", "package_version_mismatch", "installation_failed", "selection_failed":
		message = "银河更新未完成。"
	}
	if version, ok := result["runningVersion"].(string); ok && version != "" {
		message += " 当前运行版本：" + version + "。"
	}
	return message
}

// Local identity does not establish a remote connection. Query the shared
// service separately and report connection status as unchecked.
func printHumanStatus(ctx context.Context, identity map[string]any, recovery bool) error {
	identityText := "尚未发现本机身份。"
	if recovery {
		identityText = "本机身份状态需要恢复后确认。"
	} else if identity != nil {
		identityText = "已发现本机身份。"
		if id, ok := identity["id"].(string); ok && id != "" {
			identityText = "本机银河 ID：" + id + "。"
		}
	}
	serviceText := "本机服务状态暂不可用。"
	info, err := nativebridge.Status(ctx)
	if err == nil {
		serviceText = "本机服务正在运行。"
		if info.ReleaseID != "" {
			serviceText += " 运行版本：" + info.ReleaseID + "。"
		}
	} else if errors.Is(err, nativebridge.ErrPaused) {
		serviceText = "本机服务已停止。"
	} else if errors.Is(err, nativebridge.ErrUnavailable) {
		serviceText = "未检测到可用的本机服务。"
	}
	_, err = fmt.Fprintln(os.Stdout, identityText+"\n"+serviceText)
	return err
}
