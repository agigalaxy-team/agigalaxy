package main

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsstrategies"
	"github.com/jackc/pgx/v5"
)

func policySeconds(value any) int64 {
	switch n := value.(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		v, _ := n.Int64()
		return v
	}
	return 0
}

func previewScanFile(ctx context.Context, tx pgx.Tx, id string, lookup func(context.Context, pgx.Tx, string, string) (filegovernance.Object, error)) (operationsstrategies.Object, error) {
	for _, typ := range []string{"chat", "forum"} {
		r, err := lookup(ctx, tx, typ, id)
		if fault.Status(err) == 404 {
			continue
		}
		if err != nil {
			return nil, err
		}
		version := r["version"]
		if version == nil {
			version = r["revision"]
		}
		return operationsstrategies.Object{"kind": typ + "-file", "available": r["purged_at"] == nil && r["revoked_at"] == nil, "version": version}, nil
	}
	return operationsstrategies.Object{"available": false, "version": nil}, nil
}

// One execution authority is shared by qualification, the native gateway and
// the actual content writer. A role/catalog entry alone is never readiness.
func connectExecutions(gateway *access.Gateway, permissions *p.Service, autonomy *operationsautonomy.Service, content *operationscommunity.Service, files *filegovernance.Service, client *agentos.Client, search func() *discovery.Runtime) (*agentos.ExecutionGateway, *operationsstrategies.Service) {
	executions := &agentos.Executions{Pool: permissions.Pool, Endpoint: permissions.Endpoint, Permissions: permissions,
		Supported: []string{"strategies.read", "strategies.ordinary.configure", "strategies.ordinary.publish"}}
	authority := &p.BusinessAuthority{Human: gateway, Duty: autonomy, Execution: executions}
	content.Authority = authority
	strategies := &operationsstrategies.Service{Pool: permissions.Pool, Endpoint: permissions.Endpoint, Authority: authority,
		Duty: autonomy, Autonomy: autonomy, Executor: executions, StoredAuthority: gateway.StoredOperators(),
		RequireExecutionWithin: executions.RequireExecutionWithin, Native: &operationsstrategies.NativeClient{Client: client}}
	executions.QualifyWithin = agentos.QualifyExecutionSources(content.QualifyPublicExecutionWithin, strategies.QualifyOrdinaryExecutionWithin)
	executionGateway := &agentos.ExecutionGateway{Authority: executions,
		ReadContent: func(ctx context.Context, a p.Actor, kind, id string) (agentos.Object, error) {
			return content.Content(ctx, a, kind, id, agentos.Object{})
		}, Visibility: content.ContentVisibility,
		SearchSelected: func(ctx context.Context, input agentos.Object, refs []agentos.ExecutionSourceRef) (agentos.Object, error) {
			runtime := search()
			if runtime == nil {
				return nil, fault.New("discovery_search_not_connected", 503)
			}
			selected := make([]discovery.Reference, 0, len(refs))
			for _, ref := range refs {
				selected = append(selected, discovery.Reference{Kind: ref.Kind, ID: ref.ID})
			}
			return runtime.SearchSelected(ctx, input, selected)
		}}
	strategies.Effects = &operationsstrategies.EffectsAdapter{PoolReader: strategies, Executions: executions,
		Gateway: executionGateway, Content: content, PriorPreparedEffect: executionGateway.PreparedEffect}
	strategies.ActionReady = func(code, mode string) bool {
		if mode == "code" {
			return code == "content.restore" && autonomy.ExecuteDutyOperation != nil && autonomy.ActionReady != nil && autonomy.ActionReady(code)
		}
		return code == "content.read" || code == "content.hide" || code == "content.restore"
	}
	strategies.PreviewObjectWithin = func(ctx context.Context, tx pgx.Tx, a p.Actor, kind, id string) (operationsstrategies.Object, error) {
		switch kind {
		case "file-scan-retry":
			if files == nil {
				return operationsstrategies.Object{"available": false, "version": nil}, nil
			}
			return previewScanFile(ctx, tx, id, files.ScopeActionFileWithin)
		case "content-visibility", "content-curation", "public-content-batch":
			for _, typ := range []string{"post", "reply"} {
				r, err := content.Forum.OperationsContentSourceWithin(ctx, tx, typ, id, false)
				if fault.Status(err) == 404 {
					continue
				}
				if err != nil {
					return nil, err
				}
				head, _ := r["head"].(map[string]any)
				source, _ := r["source"].(map[string]any)
				revision := head["revision"]
				if revision == nil {
					revision = head["head_version"]
				}
				return operationsstrategies.Object{"kind": typ, "available": r["available"], "version": source["id"], "revision": revision}, nil
			}
		}
		return operationsstrategies.Object{"available": false, "version": nil}, nil
	}
	return executionGateway, strategies
}
