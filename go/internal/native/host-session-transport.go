package native

import (
	"context"
	"log/slog"
	"sync"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const hostSessionMethod = "notifications/galaxy/host-session-complete"

type hostSessionNotice struct {
	GalaxyID  string `json:"galaxyId"`
	Host      string `json:"host"`
	SessionID string `json:"sessionId"`
	scope     ChoiceScope
}

// HostSessionTransport accepts only a reference from the owning stdio host.
// It adds no model tool or second uploader; ordinary MCP frames pass unchanged.
func HostSessionTransport(runtime *Runtime, transport mcp.Transport) mcp.Transport {
	return &hostSessionTransport{runtime: runtime, Transport: transport}
}

type hostSessionTransport struct {
	mcp.Transport
	runtime *Runtime
}

func (t *hostSessionTransport) SupportsProtocolVersion(version string) bool {
	if support, ok := t.Transport.(mcp.ProtocolVersionSupporter); ok {
		return support.SupportsProtocolVersion(version)
	}
	return true
}

func (t *hostSessionTransport) Connect(ctx context.Context) (mcp.Connection, error) {
	connection, err := t.Transport.Connect(ctx)
	if err != nil {
		return nil, err
	}
	lifecycle, cancel := context.WithCancel(ctx)
	c := &hostSessionConnection{Connection: connection, runtime: t.runtime, lifecycle: lifecycle, cancel: cancel, notices: make(chan hostSessionNotice, 32), done: make(chan struct{})}
	go c.process()
	return c, nil
}

type hostSessionConnection struct {
	mcp.Connection
	runtime    *Runtime
	lifecycle  context.Context
	cancel     context.CancelFunc
	notices    chan hostSessionNotice
	done       chan struct{}
	closeOnce  sync.Once
	closeError error
}

func (c *hostSessionConnection) Read(ctx context.Context) (jsonrpc.Message, error) {
	for {
		message, err := c.Connection.Read(ctx)
		if err != nil {
			c.cancel()
			return nil, err
		}
		request, ok := message.(*jsonrpc.Request)
		if !ok || request.Method != hostSessionMethod || request.IsCall() {
			return message, nil
		}
		var notice hostSessionNotice
		if len(request.Params) > 2048 || protocol.Decode(request.Params, &notice) != nil || !validID(notice.Host) || !validID(notice.SessionID) {
			slog.Warn("host session notification rejected", "code", "native_host_request_invalid")
			continue
		}
		scope, err := c.runtime.store.ChoiceScope(ctx)
		if err != nil || scope.Owner == "" || scope.Owner != notice.GalaxyID {
			slog.Warn("host session notification rejected", "code", "native_connection_selection_changed")
			continue
		}
		notice.scope = scope
		select {
		case c.notices <- notice:
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-c.lifecycle.Done():
			return nil, c.lifecycle.Err()
		}
	}
}

func (c *hostSessionConnection) process() {
	defer close(c.done)
	for {
		select {
		case <-c.lifecycle.Done():
			return
		case notice := <-c.notices:
			ctx := uploadScopeContext(c.lifecycle, notice.scope)
			if _, err := c.runtime.PrivateSessionComplete(ctx, notice.Host, notice.SessionID); err != nil && ctx.Err() == nil {
				slog.Warn("host session upload continuation stopped", "code", fault.Code(err))
			}
		}
	}
}

func (c *hostSessionConnection) Close() error {
	c.closeOnce.Do(func() {
		c.cancel()
		c.closeError = c.Connection.Close()
		<-c.done
	})
	return c.closeError
}
