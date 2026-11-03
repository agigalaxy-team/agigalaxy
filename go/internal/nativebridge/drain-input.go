package nativebridge

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync/atomic"
)

type relayOutput struct{ state *relayDrainState }

func (w relayOutput) Write(p []byte) (int, error) { return w.state.outputWrite(p) }

// controlledInput receives negotiated packets in order and feeds the existing
// MCP/host parser. Request IDs are recorded before their bytes are exposed.
type controlledInputReader struct {
	reader *bufio.Reader
	ended  atomic.Bool
}

func (r *controlledInputReader) Read(p []byte) (int, error) { return r.reader.Read(p) }
func controlledInput(ctx context.Context, raw io.Reader, state *relayDrainState, record bool) *controlledInputReader {
	reader, writer := io.Pipe()
	result := &controlledInputReader{reader: bufio.NewReaderSize(reader, 65536)}
	go func() {
		defer writer.Close()
		var pending bytes.Buffer
		for {
			packet, err := readRelayPacket(raw)
			if err != nil {
				if errors.Is(err, errRelayInputEnded) {
					result.ended.Store(true)
				} else if !errors.Is(err, io.EOF) {
					_ = writer.CloseWithError(err)
				}
				return
			}
			if packet.Kind == relayControl {
				var msg struct {
					Type    string `json:"type"`
					Sent    uint64 `json:"sentMessageCount"`
					Attempt string `json:"attempt"`
				}
				if json.Unmarshal(packet.Data, &msg) != nil {
					_ = writer.CloseWithError(errors.New("native relay control invalid"))
					return
				}
				state.mu.Lock()
				if msg.Attempt != state.attempt {
					state.mu.Unlock()
					continue
				}
				switch msg.Type {
				case "pauseAck":
					state.paused = true
					state.pauseSent = msg.Sent
				case "drainedAck":
					state.drained = true
				default:
					state.mu.Unlock()
					_ = writer.CloseWithError(errors.New("native relay control invalid"))
					return
				}
				state.signal()
				state.mu.Unlock()
				continue
			}
			_, _ = pending.Write(packet.Data)
			for {
				line, err := pending.ReadBytes('\n')
				if err != nil {
					_, _ = pending.Write(line)
					break
				}
				if record {
					state.incoming(line)
				}
				if _, err = writer.Write(line); err != nil {
					return
				}
			}
			if ctx.Err() != nil {
				return
			}
		}
	}()
	return result
}
