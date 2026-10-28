package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"regexp"
	"sync"
)

var referenceSubject = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)

func (r *Runtime) ReadProfileNames(ctx context.Context, subjectIDs []string) (map[string]any, error) {
	if len(subjectIDs) > 20 {
		return nil, fault.New("profile_names_input_invalid", 400)
	}
	ids := []string{}
	seen := map[string]bool{}
	for _, id := range subjectIDs {
		if !referenceSubject.MatchString(id) {
			return nil, fault.New("profile_names_input_invalid", 400)
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	operation, cancel, lease, e := r.identityLease(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	results := make([]any, len(ids))
	for start := 0; start < len(ids); start += 4 {
		end := start + 4
		if end > len(ids) {
			end = len(ids)
		}
		var pending sync.WaitGroup
		for index := start; index < end; index++ {
			pending.Add(1)
			go func(index int) {
				defer pending.Done()
				id := ids[index]
				result, e := lease.call(operation, "/v1/history/query", map[string]any{"subjectId": id, "limit": 1}, false)
				row := map[string]any{"subjectId": id, "displayName": nil}
				if e != nil {
					row["error"] = runtimeErrorCode(e)
				} else {
					if name := uploadTrim(text(uploadObject(result["selfDeclared"])["displayName"])); name != "" {
						row["displayName"] = name
					}
					if expires, present := result["selfDeclaredReadExpiresAt"]; present {
						row["readExpiresAt"] = expires
					}
				}
				results[index] = row
			}(index)
		}
		pending.Wait()
	}
	if e = lease.check(operation); e != nil {
		return nil, e
	}
	return map[string]any{"items": results}, nil
}
func registerNativeReferenceTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	addNativeTool(server, &mcp.Tool{Name: "galaxy_profile_names", Description: "Read only current permitted self-declared display names for already known subject references. Missing or withdrawn names stay null; no provider identity or old profile fallback.", InputSchema: objectSchema(map[string]any{"subjectIds": map[string]any{"type": "array", "maxItems": 20, "items": map[string]any{"type": "string", "pattern": "^GUID[0-9A-Z]{28}$"}}}, "subjectIds"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "profile_names_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input struct {
			SubjectIDs []string `json:"subjectIds"`
		}
		if e := protocol.Decode(request.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		value, e := runtime.ReadProfileNames(ctx, input.SubjectIDs)
		if e != nil {
			return toolError(e)
		}
		return toolResult(value)
	})
	addNativeTool(server, &mcp.Tool{Name: "galaxy_native_receipt_status", Description: "Read only this current local device owner's exact original Choice receipt, including after the ordinary session expires. Creates no binding or writable session, uploads no original body and never resends the operation.", InputSchema: objectSchema(map[string]any{"kind": map[string]any{"const": "choice-snapshot"}, "snapshotId": materialUUID(), "versionId": materialUUID(), "requestHash": map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}}, "kind", "snapshotId", "versionId", "requestHash"), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, "receipt_status_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var input ReceiptOperation
		if e := protocol.Decode(request.Params.Arguments, &input); e != nil {
			return toolError(e)
		}
		value, e := runtime.QueryReceipt(ctx, input)
		if e != nil {
			return toolError(e)
		}
		return toolResult(value)
	})
}
