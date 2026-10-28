package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func nativeWatchContracts() map[string]any {
	var out map[string]any
	_ = protocol.Decode([]byte(nativeWatchContractsJSON), &out)
	return out
}
func registerNativeWatchTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) func() {
	host := NewNativeWatchRuntime(runtime)
	runtime.mu.Lock()
	if runtime.nativeWatch == nil {
		runtime.nativeWatch = host
	} else {
		host = runtime.nativeWatch
	}
	runtime.mu.Unlock()
	for name, raw := range nativeWatchContracts() {
		contract := uploadObject(raw)
		write := isOne(name, "galaxy_watch_host_activate", "galaxy_watch_start", "galaxy_watch_ack", "galaxy_watch_pause", "galaxy_watch_resume", "galaxy_watch_stop")
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(contract["description"]), InputSchema: contract["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "watch_operation_unavailable", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := connectionObject(request.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			if name == "galaxy_watch_status" {
				out, e := host.LocalStatus(ctx, text(input["id"]))
				if e != nil {
					return toolError(e)
				}
				return toolResult(out)
			}
			if name == "galaxy_watch_host_capabilities" && len(runtime.config.WatchHost) == 0 {
				return toolResult(map[string]any{"configured": false, "modelStarted": false})
			}
			operation, cancel, l, e := runtime.identityLease(ctx, false)
			if e != nil {
				return toolError(e)
			}
			defer cancel()
			ctx = operation
			id := text(input["id"])
			run := func(scope *ChoiceScope) (any, error) {
				switch name {
				case "galaxy_watch_host_capabilities":
					driver, configuration, e := host.driver(l)
					if e != nil {
						return nil, e
					}
					if driver == nil {
						return map[string]any{"configured": false, "modelStarted": false}, nil
					}
					capabilities, e := driver.Capabilities(ctx)
					if e != nil {
						return nil, e
					}
					if e = l.check(ctx); e != nil {
						return nil, e
					}
					capabilities["configured"] = true
					capabilities["workingDirectory"] = configuration["cwd"]
					capabilities["modelStarted"] = false
					return capabilities, nil
				case "galaxy_watch_host_activate":
					driver, configuration, e := host.driver(l)
					if e != nil {
						return nil, e
					}
					if driver == nil {
						return nil, watchFailure("watch_host_not_configured")
					}
					if configuration["kind"] == "claude-code" {
						capabilities, e := driver.Capabilities(ctx)
						if e != nil {
							return nil, e
						}
						if e = l.check(ctx); e != nil {
							return nil, e
						}
						if capabilities["backgroundReaderSupported"] != true {
							reason := capabilities["backgroundReaderReason"]
							if reason == nil {
								reason = "effective-managed-policy-unconfirmed"
							}
							return map[string]any{"state": "foreground-fallback", "reason": reason, "hostModelEnabled": false, "modelStarted": false, "modelCalls": 0, "foregroundFallback": true}, nil
						}
					}
					if e = host.restore(ctx, l, false); e != nil {
						return nil, e
					}
					return host.Activate(ctx, l, id, map[string]any{"model": input["model"], "cwd": configuration["cwd"]}, scope)
				case "galaxy_watch_host_reconcile":
					if e := host.restore(ctx, l, false); e != nil {
						return nil, e
					}
					return host.ReconcileHost(ctx, l, id, text(input["workId"]))
				case "galaxy_watch_start":
					started, e := host.watch.StartReviewed(ctx, l, input, scope)
					if e != nil {
						return nil, e
					}
					items := uploadRows(started["items"])
					if len(items) == 0 {
						return nil, watchFailure("watch_missing")
					}
					id = text(uploadObject(items[0])["id"])
					if e = host.restore(ctx, l, true); e != nil {
						return nil, e
					}
					_, e = host.Activate(ctx, l, id, nil, nil)
					if e != nil {
						return nil, e
					}
					started["hostRuntimeState"] = "running-host"
					return started, nil
				case "galaxy_watch_status":
					return host.Status(ctx, l, id)
				case "galaxy_watch_check":
					if e := host.restore(ctx, l, true); e != nil {
						return nil, e
					}
					host.mu.Lock()
					runner := host.runners[watchRunnerKey(l, id)]
					host.mu.Unlock()
					if runner == nil {
						if _, e = host.Activate(ctx, l, id, nil, nil); e != nil {
							return nil, e
						}
					}
					return host.Check(ctx, l, id, "manual")
				case "galaxy_watch_ack":
					if e := host.restore(ctx, l, true); e != nil {
						return nil, e
					}
					host.mu.Lock()
					runner := host.runners[watchRunnerKey(l, id)]
					host.mu.Unlock()
					if runner == nil {
						if _, e = host.Activate(ctx, l, id, nil, nil); e != nil {
							return nil, e
						}
					}
					return host.Ack(ctx, l, id, text(input["workId"]))
				case "galaxy_watch_pause", "galaxy_watch_stop":
					if e := host.restore(ctx, l, true); e != nil {
						return nil, e
					}
					state := "stopped"
					if name == "galaxy_watch_pause" {
						state = "paused"
					}
					return host.Halt(ctx, l, id, state)
				case "galaxy_watch_resume":
					resumed, e := host.watch.ResumeReviewed(ctx, l, input, scope)
					if e != nil {
						return nil, e
					}
					if e = host.restore(ctx, l, true); e != nil {
						return nil, e
					}
					if _, e = host.Activate(ctx, l, id, nil, nil); e != nil {
						return nil, e
					}
					resumed["hostRuntimeState"] = "running-host"
					return resumed, nil
				}
				return nil, remoteFactsInvalid()
			}
			if isOne(name, "galaxy_watch_host_activate", "galaxy_watch_start", "galaxy_watch_pause", "galaxy_watch_resume") {
				value := map[string]any{"input": input, "authorizationContext": map[string]any{"subjectId": l.scope.Owner, "endpoint": l.scope.Endpoint, "bindingId": l.connection.bindingID, "generation": l.connection.generation}}
				return tools.review(ctx, request, value, "请本人核对这段工作的关注用途、房间与精确Agent许可；暂停会撤销原许可，恢复必须选择新的当前许可。只有明确选择宿主型号才会调用该用户宿主。\n"+hostJSONString(value), func(scope *ChoiceScope) (any, error) {
					if scope == nil || *scope != l.scope {
						return nil, watchFailure("watch_binding_changed")
					}
					if e = l.check(ctx); e != nil {
						return nil, e
					}
					return run(scope)
				})
			}
			out, e := run(nil)
			if e != nil {
				return toolError(e)
			}
			return toolResult(out)
		})
	}
	return host.Close
}
