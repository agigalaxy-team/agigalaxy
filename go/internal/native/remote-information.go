package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/recruitment"
	"github.com/agigalaxy-team/agigalaxy/go/internal/watchcontrol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type NativeInformation struct{ runtime *Runtime }

func NewNativeInformation(runtime *Runtime) *NativeInformation { return &NativeInformation{runtime} }

// Zod applies these original transforms/refinements before its length checks.
// JSON Schema alone does not carry trim or unique-source-key refinements.
func remoteSelectedInput(contracts map[string]any, name string, input any) (map[string]any, error) {
	raw, e := jstext.EncodeJSON(input)
	if e != nil {
		return nil, e
	}
	var normalized any = input
	switch name {
	case "galaxy_recruitment_v2_query":
		normalized, e = recruitment.ParseQuery(raw)
	case "galaxy_information_query":
		normalized, e = information.ParseQuery(raw)
	case "galaxy_information_watch_change":
		normalized, e = information.ParseWatchRequest(raw, "command")
	case "galaxy_information_watches":
		normalized, e = information.ParseWatchRequest(raw, "list")
	case "galaxy_information_watch_receipt":
		normalized, e = information.ParseWatchRequest(raw, "receipt")
	case "galaxy_information_watch_check":
		normalized, e = information.ParseWatchRequest(raw, "check")
	case "galaxy_watch_control_enable":
		normalized, e = watchcontrol.ParseRequest(raw, "register")
	case "galaxy_watch_control_takeover":
		normalized, e = watchcontrol.ParseRequest(raw, "takeover")
	case "galaxy_watch_control_stop":
		normalized, e = watchcontrol.ParseRequest(raw, "stop")
	case "galaxy_watch_control_query":
		normalized, e = watchcontrol.ParseRequest(raw, "query")
	case "galaxy_watch_control_read":
		normalized, e = watchcontrol.ParseRequest(raw, "read")
	}
	if e != nil {
		return nil, remoteFactsInvalid()
	}
	return remoteReputationInput(contracts, name, normalized)
}
func (c *NativeInformation) Call(ctx context.Context, name string, input any) (map[string]any, error) {
	if c == nil || c.runtime == nil {
		return nil, fault.New("native_runtime_unavailable", 503)
	}
	value, e := remoteSelectedInput(remoteSelectedContracts(remoteInformationContractsJSON), name, input)
	if e != nil {
		return nil, e
	}
	raw, e := jstext.EncodeJSON(value)
	if e != nil {
		return nil, e
	}
	path, kind := "", ""
	switch name {
	case "galaxy_information_query":
		path = "/v2/information/query"
		value, e = information.ParseQuery(raw)
	case "galaxy_information_watch_change":
		path = "/v2/information/watches/command"
		kind = "command"
	case "galaxy_information_watches":
		path = "/v2/information/watches/list"
		kind = "list"
	case "galaxy_information_watch_receipt":
		path = "/v2/information/watches/receipt"
		kind = "receipt"
	case "galaxy_information_watch_check":
		path = "/v2/information/watches/check"
		kind = "check"
	case "galaxy_information_watch_events":
		path = "/v2/information/watches/events"
	default:
		return nil, remoteFactsInvalid()
	}
	if kind != "" {
		value, e = information.ParseWatchRequest(raw, kind)
	}
	if e != nil {
		return nil, remoteFactsInvalid()
	}
	scope, e := c.runtime.store.ChoiceScope(ctx)
	if e != nil {
		return nil, e
	}
	return c.runtime.Call(ctx, path, value, ConnectionCallOptions{ExpectedScope: &scope})
}
func registerRemoteInformationTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	client := NewNativeInformation(runtime)
	registerSelectedRemoteTools(server, tools, remoteSelectedContracts(remoteInformationContractsJSON), func(ctx context.Context, name string, input any, _ *ChoiceScope) (any, error) {
		return client.Call(ctx, name, input)
	})
}
