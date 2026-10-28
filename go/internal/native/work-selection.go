package native

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type NativeWorkSelection struct{ runtime *Runtime }

func NewNativeWorkSelection(r *Runtime) *NativeWorkSelection { return &NativeWorkSelection{runtime: r} }
func workSelectableAttempts(view map[string]any, owner string) []any {
	out := []any{}
	scope, present := view["scopeVersion"]
	for _, a := range workLatest(uploadRows(view["attempts"])) {
		matches := !present || scope == nil && a["scopeVersion"] == nil || scope != nil && a["scopeVersion"] != nil && integer(a["scopeVersion"]) == integer(scope)
		if a["provenance"] == "native-v2" && a["actorId"] == owner && matches {
			out = append(out, a)
		}
	}
	return out
}
func (c *NativeWorkSelection) Call(ctx context.Context, name string, input any) (any, error) {
	x, e := workPurposeNormalize(name, input)
	if e != nil {
		return nil, e
	}
	ctx, cancel, l, e := c.runtime.identityLease(ctx, true)
	if e != nil {
		return nil, e
	}
	defer cancel()
	switch name {
	case "galaxy_work_sources":
		query := map[string]any{"subjectId": l.scope.Owner, "limit": 7}
		if x["after"] != nil {
			query["after"] = x["after"]
		}
		page, e := l.call(ctx, "/v2/history/query", query, false)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, raw := range uploadRows(page["items"]) {
			view := uploadObject(raw)
			if view["kind"] != "case-history" || view["caseId"] == nil {
				continue
			}
			attempts := []any{}
			for _, v := range workSelectableAttempts(view, l.scope.Owner) {
				a := uploadObject(v)
				attempts = append(attempts, map[string]any{"id": a["id"], "version": a["version"], "strategy": a["strategy"], "taskId": a["taskId"]})
			}
			if len(attempts) == 0 {
				continue
			}
			title := view["title"]
			if title == nil {
				title = "当前工作"
			}
			summary := view["summary"]
			if summary == nil {
				summary = ""
			}
			items = append(items, map[string]any{"caseId": view["caseId"], "title": title, "summary": summary, "synthetic": view["synthetic"], "attempts": attempts})
		}
		return map[string]any{"items": items, "nextCursor": page["nextCursor"]}, l.check(ctx)
	case "galaxy_work_read":
		query := map[string]any{}
		if x["taskId"] != nil {
			query["taskId"] = x["taskId"]
		}
		view, e := l.call(ctx, "/v2/cases/"+text(x["caseId"])+"/read", query, false)
		if e != nil {
			return nil, e
		}
		title := any("当前工作")
		summary := any("")
		for _, raw := range uploadRows(view["events"]) {
			event := uploadObject(raw)
			if event["kind"] == "case-created" {
				if event["title"] != nil {
					title = event["title"]
				}
				if event["summary"] != nil {
					summary = event["summary"]
				}
				break
			}
		}
		view["title"] = title
		view["summary"] = summary
		view["subjectId"] = l.scope.Owner
		view["selectableAttempts"] = workSelectableAttempts(view, l.scope.Owner)
		return view, l.check(ctx)
	}
	return nil, remoteFactsInvalid()
}
func registerNativeWorkSelectionTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeWorkSelection(runtime)
	contracts := workPurposeContracts()
	for _, name := range []string{"galaxy_work_sources", "galaxy_work_read"} {
		c := uploadObject(contracts[name])
		addNativeTool(server, &mcp.Tool{Name: name, Description: text(c["description"]), InputSchema: c["schema"], Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "current_work_unavailable", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := connectionObject(req.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			out, e := client.Call(ctx, name, input)
			if e != nil {
				result, encoding := toolResult(map[string]any{"error": runtimeErrorCode(e), "originalWorkRetained": true})
				if result != nil {
					result.IsError = true
				}
				return result, encoding
			}
			return toolResult(out)
		})
	}
}
