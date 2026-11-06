package native

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// helpMCPView changes only the outward Help tool presentation. Stored sessions,
// choice previews and signed business bytes remain the original values.
func helpMCPView(name string, value any) any {
	original, ok := value.(map[string]any)
	if !ok {
		return value
	}
	out := helpCopyMap(original)
	switch name {
	case "galaxy_help_start", "galaxy_help_get", "galaxy_help_compose", "galaxy_help_select", "galaxy_help_pause":
		helpStripStaticSession(out)
	case "galaxy_help_prepare_action", "galaxy_help_action_preview":
		helpStripPreviewInput(out)
	}
	switch name {
	case "galaxy_help_query", "galaxy_help_refresh", "galaxy_help_return", "galaxy_help_review", "galaxy_help_publish", "galaxy_help_reconcile":
		if originalSession, ok := out["session"].(map[string]any); ok {
			session := helpCopyMap(originalSession)
			helpStripStaticSession(session)
			if name == "galaxy_help_query" || name == "galaxy_help_refresh" || name == "galaxy_help_return" {
				delete(session, "queries")
				delete(session, "basis")
				delete(session, "offers")
			}
			out["session"] = session
		}
	case "galaxy_help_execute_action", "galaxy_help_reconcile_action":
		if operation, ok := out["operation"].(map[string]any); ok {
			copied := helpCopyMap(operation)
			helpStripPreviewInput(copied)
			out["operation"] = copied
		}
		// Browser fallback: preview is the exact review input; its preview field is
		// the Help action preview. Its payload and all other source values stay intact.
		if name == "galaxy_help_execute_action" {
			if review, ok := out["preview"].(map[string]any); ok {
				copiedReview := helpCopyMap(review)
				if preview, ok := copiedReview["preview"].(map[string]any); ok {
					copiedPreview := helpCopyMap(preview)
					helpStripPreviewInput(copiedPreview)
					copiedReview["preview"] = copiedPreview
				}
				out["preview"] = copiedReview
			}
		}
	}
	return out
}
func helpCopyMap(value map[string]any) map[string]any {
	out := make(map[string]any, len(value))
	for key, item := range value {
		out[key] = item
	}
	return out
}
func helpStripStaticSession(session map[string]any) {
	for _, key := range []string{"paths", "warnings", "requestDefaults", "activeEntries"} {
		delete(session, key)
	}
}
func helpStripPreviewInput(preview map[string]any) {
	if input, ok := preview["prepareInput"].(map[string]any); ok {
		copied := helpCopyMap(input)
		delete(copied, "payloadJson")
		if len(copied) == 0 {
			delete(preview, "prepareInput")
		} else {
			preview["prepareInput"] = copied
		}
	}
}

var helpErrorMessages = map[string]string{
	"help_operation_failed":                       "本次操作未完成。",
	"help_operation_invalid":                      "操作内容不符合要求。",
	"help_source_invalid":                         "未能读取来源资料。",
	"help_task_already_linked":                    "当前会话已经关联求助。",
	"help_acknowledged_task_required":             "请先确认已发布的求助。",
	"help_task_mismatch":                          "所选求助与当前会话不一致。",
	"help_original_task_mismatch":                 "原工作与当前操作不一致。",
	"help_action_payload_too_large":               "这次操作的内容过长。",
	"help_context_unavailable":                    "当前材料不可读取。",
	"help_participation_unavailable":              "当前参与安排不可读取。",
	"help_invitation_unavailable":                 "当前邀请不可读取。",
	"help_reuse_source_required":                  "请先读取可用的方法或经验来源。",
	"help_selected_offer_required":                "请先选择帮助方式。",
	"help_session_changed":                        "求助会话已更新，请重新读取。",
	"help_session_not_found":                      "没有找到这份本机求助会话。",
	"help_identity_changed":                       "当前身份与这份求助不一致。",
	"help_endpoint_changed":                       "当前连接的服务与这份求助不一致。",
	"help_scope_mismatch":                         "当前身份或服务与原操作不一致。",
	"help_basis_not_observed":                     "请先读取当前来源，再引用它。",
	"help_participant_not_observed":               "请先读取该参与者及其来源。",
	"help_selection_refresh_required":             "所选来源需要重新读取。",
	"help_selected_offer_immutable":               "已选帮助内容不能直接改写，请先取消选择。",
	"help_reconcile_original_operation":           "这次操作的结果尚未确认。",
	"help_operation_conflict":                     "操作标识与原内容不一致。",
	"help_action_unavailable":                     "没有找到这次操作。",
	"help_action_preview_changed":                 "操作内容已变化，请重新预览。",
	"help_authorization_preview_changed":          "授权选择已变化，请重新预览。",
	"help_authorization_refresh_required":         "原授权已过期，需要重新确认。",
	"help_authorization_renewal_requires_absence": "续授权前请先核对原操作结果。",
	"help_receipt_mismatch":                       "服务回执与原操作不一致。",
	"help_receipt_unavailable":                    "暂未取得处理结果。",
	"help_task_version_changed":                   "求助已有更新，请重新读取。",
	"help_participation_version_changed":          "参与安排已有更新，请重新读取。",
	"help_context_material_changed":               "材料已变化，请重新读取。",
	"help_local_storage_full":                     "本机存储空间不足。",
	"help_exact_authorization_unavailable":        "当前设备无法完成这次确认。",
}

// Browser fallback is itself an MCP result containing the preview. Project its
// text once while leaving the separately stored review and authorization intact.
func helpProjectReviewResult(name string, result *mcp.CallToolResult) (*mcp.CallToolResult, error) {
	if result == nil {
		return result, nil
	}
	for i, part := range result.Content {
		content, ok := part.(*mcp.TextContent)
		if !ok {
			continue
		}
		value, err := jstext.DecodeJSON([]byte(content.Text))
		if err != nil {
			return nil, err
		}
		if result.IsError {
			if code := text(psObject(value)["error"]); code != "" {
				return helpToolError(helpError(code))
			}
		}
		encoded, err := protocol.Encode(helpMCPView(name, value))
		if err != nil {
			return nil, err
		}
		clone := *content
		clone.Text = string(encoded)
		result.Content[i] = &clone
	}
	return result, nil
}
