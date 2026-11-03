package nativebridge

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type trackedTransport struct {
	mcp.Transport
	state       *relayDrainState
	hostNotices bool
}

func (t *trackedTransport) SupportsProtocolVersion(version string) bool {
	if p, ok := t.Transport.(mcp.ProtocolVersionSupporter); ok {
		return p.SupportsProtocolVersion(version)
	}
	return true
}
func (t *trackedTransport) Connect(ctx context.Context) (mcp.Connection, error) {
	c, e := t.Transport.Connect(ctx)
	if e != nil {
		return nil, e
	}
	return &trackedConnection{Connection: c, state: t.state, hostNotices: t.hostNotices}, nil
}

type trackedConnection struct {
	mcp.Connection
	state         *relayDrainState
	pendingNotice []byte
	hostNotices   bool
}

func (c *trackedConnection) Read(ctx context.Context) (jsonrpc.Message, error) {
	if c.pendingNotice != nil {
		c.state.incoming(c.pendingNotice)
		c.pendingNotice = nil
	}
	m, e := c.Connection.Read(ctx)
	if e == nil {
		if b, err := jsonrpc.EncodeMessage(m); err == nil {
			if request, ok := m.(*jsonrpc.Request); c.hostNotices && ok && request.Method == "notifications/galaxy/host-session-complete" && !request.IsCall() {
				c.pendingNotice = b
			} else {
				c.state.incoming(b)
			}
		}
	}
	return m, e
}
