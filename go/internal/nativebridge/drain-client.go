package nativebridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

func relayControlled(ctx context.Context, p Profile, ch Channel, input io.Reader, output io.Writer, conn net.Conn, reader *bufio.Reader, info *Info) error {
	var connMu sync.Mutex
	defer func() { connMu.Lock(); _ = conn.Close(); connMu.Unlock() }()
	stop := context.AfterFunc(ctx, func() { connMu.Lock(); _ = conn.Close(); connMu.Unlock() })
	defer stop()
	relay := &controlledRelay{writer: &relayPacketWriter{w: conn}, channel: ch, input: input, output: output, wake: make(chan struct{}, 1), sendError: make(chan error, 1), done: make(chan struct{})}
	defer close(relay.done)
	go relay.inputLoop()
	go relay.senderLoop()
	instance := ""
	if info != nil {
		instance = info.InstanceID
	}
	for {
		packet, err := readRelayPacket(reader)
		if err != nil {
			select {
			case sendErr := <-relay.sendError:
				return sendErr
			default:
			}
			relay.mu.Lock()
			drained, inputEOF := relay.drained, relay.inputEOF
			relay.mu.Unlock()
			if !drained {
				if errors.Is(err, io.EOF) && inputEOF {
					return nil
				}
				if errors.Is(err, io.EOF) {
					return fault.New("native_service_connection_lost", 503)
				}
				return err
			}
			_ = conn.Close()
			nextConn, nextReader, nextInfo, e := reconnectControlled(ctx, p, ch, instance)
			if e != nil {
				return e
			}
			connMu.Lock()
			conn, reader = nextConn, nextReader
			connMu.Unlock()
			if nextInfo != nil {
				instance = nextInfo.InstanceID
			}
			relay.mu.Lock()
			relay.writer = &relayPacketWriter{w: conn}
			relay.sent = 0
			relay.drained = false
			init := append([]byte(nil), relay.initialize...)
			initialized := append([]byte(nil), relay.initialized...)
			relay.mu.Unlock()
			if ch == MCP {
				if len(init) == 0 || len(initialized) == 0 {
					return fault.New("native_handover_mcp_initialization_missing", 409)
				}
				if e = relayHandshake(reader, relay, init, initialized); e != nil {
					return e
				}
			}
			relay.mu.Lock()
			relay.paused, relay.switching = false, false
			relay.signal()
			relay.mu.Unlock()
			continue
		}
		if packet.Kind == relayControl {
			if e := relay.control(packet.Data); e != nil {
				return e
			}
			continue
		}
		relay.observeOutput(packet.Data)
		if e := writeAll(output, packet.Data); e != nil {
			return e
		}
	}
}
func reconnectControlled(ctx context.Context, p Profile, ch Channel, old string) (net.Conn, *bufio.Reader, *Info, error) {
	timeout := time.NewTimer(12 * time.Second)
	defer timeout.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		info, e := Ensure(ctx, Options{})
		if e == nil && (old == "" || info.InstanceID != old) {
			c, r, res, err := exchange(ctx, request{Version: ProtocolVersion, Action: "connect", Profile: p, Channel: ch, RelayControlVersion: 1})
			if err == nil {
				if res.RelayControlVersion != 1 {
					c.Close()
					return nil, nil, nil, fault.New("native_handover_relay_unsupported", 409)
				}
				return c, r, res.Info, nil
			}
			if !isUnavailable(err) && fault.Code(err) != "native_service_draining" {
				return nil, nil, nil, err
			}
		} else if e != nil && !errors.Is(e, ErrUnavailable) {
			return nil, nil, nil, e
		}
		select {
		case <-ctx.Done():
			return nil, nil, nil, ctx.Err()
		case <-timeout.C:
			return nil, nil, nil, fault.New("native_handover_reconnect_timeout", 409)
		case <-ticker.C:
		}
	}
}
func relayHandshake(reader *bufio.Reader, r *controlledRelay, init, initialized []byte) error {
	var request map[string]json.RawMessage
	if json.Unmarshal(bytes.TrimSpace(init), &request) != nil || relayID(request["id"]) == "" {
		return fault.New("native_handover_mcp_initialization_missing", 409)
	}
	internalID, _ := json.Marshal("galaxy-internal-" + uuid.NewString())
	request["id"] = internalID
	internalInit, err := json.Marshal(request)
	if err != nil {
		return err
	}
	internalInit = append(internalInit, '\n')
	r.mu.Lock()
	e := r.send(internalInit)
	r.mu.Unlock()
	if e != nil {
		return e
	}
	var pending bytes.Buffer
	for {
		packet, e := readRelayPacket(reader)
		if e != nil {
			return e
		}
		if packet.Kind == relayControl {
			if e = r.control(packet.Data); e != nil {
				return e
			}
			continue
		}
		_, _ = pending.Write(packet.Data)
		for {
			line, e := pending.ReadBytes('\n')
			if e != nil {
				_, _ = pending.Write(line)
				break
			}
			var msg relayWireMessage
			_ = json.Unmarshal(line, &msg)
			if msg.Method == "" && relayID(msg.ID) == relayID(internalID) {
				var reply struct {
					Error  json.RawMessage `json:"error"`
					Result struct {
						ProtocolVersion string `json:"protocolVersion"`
					} `json:"result"`
				}
				if json.Unmarshal(line, &reply) != nil || len(reply.Error) > 0 {
					return fault.New("native_handover_mcp_initialization_failed", 409)
				}
				r.mu.Lock()
				version := r.protocolVersion
				r.mu.Unlock()
				if version == "" || reply.Result.ProtocolVersion != version {
					return fault.New("native_handover_mcp_protocol_changed", 409)
				}
				if pending.Len() > 0 {
					if e = writeAll(r.output, pending.Bytes()); e != nil {
						return e
					}
				}
				r.mu.Lock()
				e = r.send(initialized)
				r.mu.Unlock()
				return e
			}
			if e = writeAll(r.output, line); e != nil {
				return e
			}
		}
	}
}
