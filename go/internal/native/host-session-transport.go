package native

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/jsonrpc"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const hostSessionMethod = "notifications/galaxy/host-session-complete"
const hostDiagnosticMethod = "notifications/galaxy/host-diagnostic"

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
	runtime      *Runtime
	lifecycle    context.Context
	cancel       context.CancelFunc
	notices      chan hostSessionNotice
	done         chan struct{}
	closeOnce    sync.Once
	closeError   error
	noticeMu     sync.Mutex
	noticeClosed bool
}

// PendingHostNotifications counts accepted host notices until their queued or
// executing continuation ends. It is scoped to this Runtime, across sessions.
func (r *Runtime) PendingHostNotifications() int {
	if r == nil {
		return 0
	}
	return int(r.hostNotices.Load())
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
			c.diagnostic("host session notification rejected", "native_host_request_invalid")
			continue
		}
		c.runtime.hostNotices.Add(1)
		scope, err := c.runtime.store.ChoiceScope(ctx)
		if err != nil || scope.Owner == "" || scope.Owner != notice.GalaxyID {
			c.runtime.hostNotices.Add(-1)
			code := "native_connection_selection_changed"
			if err != nil {
				code = fault.Code(err)
			}
			c.diagnostic("host session notification rejected", code)
			continue
		}
		notice.scope = scope
		c.noticeMu.Lock()
		if c.noticeClosed {
			c.runtime.hostNotices.Add(-1)
			c.noticeMu.Unlock()
			return nil, c.lifecycle.Err()
		}
		select {
		case c.notices <- notice:
			c.noticeMu.Unlock()
		case <-ctx.Done():
			c.runtime.hostNotices.Add(-1)
			c.noticeMu.Unlock()
			return nil, ctx.Err()
		case <-c.lifecycle.Done():
			c.runtime.hostNotices.Add(-1)
			c.noticeMu.Unlock()
			return nil, c.lifecycle.Err()
		}
	}
}

func (c *hostSessionConnection) process() {
	defer close(c.done)
	defer func() {
		c.noticeMu.Lock()
		c.noticeClosed = true
		for {
			select {
			case <-c.notices:
				c.runtime.hostNotices.Add(-1)
			default:
				c.noticeMu.Unlock()
				return
			}
		}
	}()
	for {
		select {
		case <-c.lifecycle.Done():
			return
		case notice := <-c.notices:
			ctx := uploadScopeContext(c.lifecycle, notice.scope)
			if _, err := c.runtime.PrivateSessionComplete(ctx, notice.Host, notice.SessionID); err != nil && ctx.Err() == nil {
				c.diagnostic("host session upload continuation stopped", fault.Code(err))
			}
			c.runtime.hostNotices.Add(-1)
		}
	}
}

// diagnostic belongs only to the connection that submitted the host notice.
// A notification has no request ID and never causes a business operation replay.
func (c *hostSessionConnection) diagnostic(message, code string) {
	slog.Warn(message, "code", code)
	params, err := json.Marshal(struct {
		Code string `json:"code"`
	}{Code: code})
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(c.lifecycle, 5*time.Second)
	defer cancel()
	_ = c.Connection.Write(ctx, &jsonrpc.Request{Method: hostDiagnosticMethod, Params: params})
}

func (c *hostSessionConnection) Close() error {
	c.closeOnce.Do(func() {
		c.cancel()
		c.closeError = c.Connection.Close()
		<-c.done
	})
	return c.closeError
}
