package main

import (
	"fmt"
	"os"
	"strings"
)

// The connect command reads the already selected identity, including its official
// account association. Keep the receipt tied to the connection just established.
func setupOfficialAccountState(connection, command any) string {
	connected, _ := connection.(map[string]any)
	result, _ := command.(map[string]any)
	status, _ := result["connectionContract"].(map[string]any)
	subject, _ := connected["subjectId"].(string)
	endpoint, _ := connected["endpoint"].(string)
	if status["connected"] != true || subject == "" || endpoint == "" ||
		status["identity"] != subject || status["endpoint"] != endpoint {
		return "unavailable"
	}
	account, official := status["officialAccount"]
	if !official {
		return ""
	}
	record, _ := account.(map[string]any)
	switch record["state"] {
	case "linked":
		return "linked"
	case "unlinked":
		return "unlinked"
	default:
		return "unavailable"
	}
}

func printSetupReceipt(result map[string]any) error {
	_, err := fmt.Fprintln(os.Stdout, setupReceipt(result))
	return err
}

func setupReceipt(result map[string]any) string {
	var components, lines []string
	if result["releaseInstalled"] == true {
		components = append(components, "银河客户端")
	}
	if result["skillInstalled"] == true {
		components = append(components, "Skill")
	}
	if result["observationPluginConfigured"] == true {
		components = append(components, "工作记录插件")
	}
	if len(components) > 0 {
		lines = append(lines, "已安装："+strings.Join(components, "、"))
	}
	identity, _ := result["identity"].(map[string]any)
	switch {
	case identity["created"] == true:
		lines = append(lines, "本机身份：已建立")
	case identity["existingIdentityPreserved"] == true:
		lines = append(lines, "本机身份：沿用原有身份")
	}
	service := "未连接"
	switch result["serviceConnection"] {
	case "ready":
		service = "已连接"
	case "pending":
		service = "未能确认连接"
	}
	lines = append(lines, "银河服务："+service)
	account, _ := result["officialAccount"].(map[string]any)
	switch account["state"] {
	case "linked":
		lines = append(lines, "在线账户：已关联")
	case "unlinked":
		lines = append(lines, "在线账户：尚未关联")
	case "unavailable":
		lines = append(lines, "在线账户：暂时查不到关联状态")
	default:
		if result["serviceConnection"] != "ready" {
			lines = append(lines, "在线账户：未查询")
		}
	}
	mcp := "尚未配置"
	if result["mcpConfigured"] == true {
		mcp = "已配置"
	}
	lines = append(lines, "MCP："+mcp)
	switch {
	case result["hookStatus"] == "trusted":
		lines = append(lines, "工作记录：已获宿主授权")
	case result["hooksConfigured"] == true && result["hookTrustHelp"] != nil:
		lines = append(lines, "工作记录：已配置，可在 Codex 的 Hooks 设置中启用")
	case result["hooksConfigured"] == true:
		lines = append(lines, "工作记录：已配置")
	case result["hooksConfigured"] == false:
		lines = append(lines, "工作记录：自动记录未启用")
	}
	if account["state"] == "unlinked" {
		lines = append(lines, "", "浏览公开内容无需关联账户。想在这里使用网页账户收藏时，可以请 Agent 帮你关联当前身份。")
	}
	return strings.Join(lines, "\n")
}
