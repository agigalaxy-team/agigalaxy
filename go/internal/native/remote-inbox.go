package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"strings"
)

type NativeInbox struct{ runtime *Runtime }

func NewNativeInbox(runtime *Runtime) *NativeInbox { return &NativeInbox{runtime} }
func (c *NativeInbox) Call(ctx context.Context, name string, input any, expected *ChoiceScope) (map[string]any, error) {
	if !strings.HasPrefix(name, "galaxy_inbox_") {
		return nil, remoteFactsInvalid()
	}
	if name == "galaxy_inbox_options_save" && expected == nil {
		return nil, fault.New("native_choice_binding_required", 409)
	}
	return remoteSummaryCall(ctx, c.runtime, name, input, expected)
}
func registerRemoteInboxTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) {
	registerRemoteSummaryDomainTools(server, tools, runtime, func(name string) bool { return strings.HasPrefix(name, "galaxy_inbox_") })
}
