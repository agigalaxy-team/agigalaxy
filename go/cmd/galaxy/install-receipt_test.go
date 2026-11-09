package main

import (
	"strings"
	"testing"
)

func TestSetupReceiptSeparatesAccountAndMCP(t *testing.T) {
	receipt := setupReceipt(map[string]any{
		"releaseInstalled":  true,
		"skillInstalled":    true,
		"identity":          map[string]any{"existingIdentityPreserved": true},
		"serviceConnection": "ready",
		"officialAccount":   map[string]any{"state": "unlinked"},
		"mcpConfigured":     true,
		"hooksConfigured":   true,
		"hookTrustHelp":     "Codex /hooks or Desktop Settings > Hooks",
	})
	for _, want := range []string{"已安装：银河客户端、Skill", "本机身份：沿用原有身份", "银河服务：已连接", "在线账户：尚未关联", "MCP：已配置", "工作记录：已配置", "网页账户收藏"} {
		if !strings.Contains(receipt, want) {
			t.Errorf("receipt is missing %q: %s", want, receipt)
		}
	}
	if strings.Contains(receipt, "MCP：可用") || strings.Contains(receipt, "档位") {
		t.Fatalf("receipt promoted configuration to availability or exposed a tier: %s", receipt)
	}
	for _, state := range []string{"linked", "unavailable"} {
		got := setupReceipt(map[string]any{
			"serviceConnection": "ready", "officialAccount": map[string]any{"state": state},
		})
		if strings.Contains(got, "尚未关联") || strings.Contains(got, "请 Agent") {
			t.Errorf("receipt prompted an unproven account link: %s", got)
		}
	}
}

func TestSetupAccountReadBelongsToConnectedIdentity(t *testing.T) {
	connection := map[string]any{"subjectId": "current", "endpoint": "https://official.agigalaxy.org"}
	status := map[string]any{"connected": true, "identity": "current", "endpoint": connection["endpoint"]}
	command := map[string]any{"connectionContract": status}
	for _, state := range []string{"linked", "unlinked", "unavailable"} {
		status["officialAccount"] = map[string]any{"state": state}
		if got := setupOfficialAccountState(connection, command); got != state {
			t.Errorf("account state %q became %q", state, got)
		}
	}
	status["officialAccount"] = map[string]any{"state": "linked"}
	status["identity"] = "different"
	if got := setupOfficialAccountState(connection, command); got != "unavailable" {
		t.Errorf("another identity's account state leaked into receipt: %q", got)
	}
	status["identity"] = "current"
	delete(status, "officialAccount")
	if got := setupOfficialAccountState(connection, command); got != "" {
		t.Errorf("account association appeared for a service without that facility: %q", got)
	}
}
