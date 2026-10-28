package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func registerNativeHostNotificationTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) (func(), error) {
	host, e := NewNativeHostNotifications(runtime, HostNotificationOptions{})
	if e != nil {
		return nil, e
	}
	if e = runtime.AttachNotifications(host); e != nil {
		return nil, e
	}
	var contracts map[string]any
	_ = protocol.Decode([]byte(hostNotificationContractsJSON), &contracts)
	for name, raw := range contracts {
		c := uploadObject(raw)
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(c["description"]), InputSchema: c["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: c["write"] != true}}, "notification_runtime_unavailable", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			var out any
			var e error
			switch name {
			case "galaxy_host_notifications_status":
				out, e = host.Status(ctx)
			case "galaxy_host_notifications_disable":
				out, e = host.DisableResult(ctx)
			case "galaxy_host_notifications_check":
				out, e = host.Check(ctx)
			case "galaxy_host_notifications_reconcile":
				operation, cancel, l, leaseError := runtime.identityLease(ctx, false)
				if leaseError != nil {
					return toolError(leaseError)
				}
				defer cancel()
				if l.connection.bindingID == "" {
					return toolError(connectionFailure("notification_binding_required"))
				}
				out, e = host.Reconcile(operation, l)
			case "galaxy_host_notifications_enable", "galaxy_host_notifications_permission":
				operation, cancel, l, leaseError := runtime.identityLease(ctx, false)
				if leaseError != nil {
					return toolError(leaseError)
				}
				defer cancel()
				if l.connection.bindingID == "" {
					return toolError(connectionFailure("notification_binding_required"))
				}
				host.mu.Lock()
				epoch := host.generation
				activation := host.activation
				revision := host.permissionRevision
				host.mu.Unlock()
				value := map[string]any{"activationSession": activation, "choiceEpoch": epoch, "permissionRevision": revision, "authorizationContext": map[string]any{"subjectId": l.scope.Owner, "endpoint": l.scope.Endpoint, "bindingId": l.connection.bindingID, "generation": l.connection.generation}}
				message := "请本人选择是否仅在本进程启用通用系统提醒，每60秒核对现有收件箱；系统不接收私有正文，不改人工已读，不调用模型。"
				if name == "galaxy_host_notifications_permission" {
					message = "请本人选择是否询问已配置macOS应用的系统提醒权限；这次选择不启用提醒、不显示通知，也不改变银河已读。"
				}
				return tools.review(operation, request, value, message+"\n"+hostJSONString(value), func(scope *ChoiceScope) (any, error) {
					if name == "galaxy_host_notifications_enable" {
						return host.EnableReviewed(operation, l, scope, epoch)
					}
					host.mu.Lock()
					if host.permissionRevision != revision {
						host.mu.Unlock()
						return nil, connectionFailure("notification_choice_changed")
					}
					host.permissionRevision++
					host.mu.Unlock()
					return host.PermissionReviewed(operation, l, scope, epoch)
				})
			default:
				return toolError(remoteFactsInvalid())
			}
			if e != nil {
				return toolError(e)
			}
			return toolResult(out)
		})
	}
	return host.Close, nil
}
