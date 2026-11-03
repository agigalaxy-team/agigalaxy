package nativebridge

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

type relayControlMessage struct{ kind, attempt string }

type queuedRelayMessage struct {
	data        []byte
	pass        bool
	initialized bool
}
type controlledRelay struct {
	mu                                   sync.Mutex
	writer                               *relayPacketWriter
	channel                              Channel
	paused, switching, drained, inputEOF bool
	initializedSent                      bool
	sent                                 uint64
	queued                               []queuedRelayMessage
	controls                             []relayControlMessage
	wake                                 chan struct{}
	sendError                            chan error
	done                                 chan struct{}
	initialize, initialized              []byte
	attempt                              string
	protocolVersion                      string
	outputBuffer                         bytes.Buffer
	input                                io.Reader
	output                               io.Writer
}

func (r *controlledRelay) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// send is used for the internal handshake only while the sender is parked.
func (r *controlledRelay) send(line []byte) error {
	if _, err := r.writer.Write(line); err != nil {
		return err
	}
	r.sent++
	return nil
}
func (r *controlledRelay) inputLoop() {
	reader := bufio.NewReaderSize(r.input, 65536)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var msg relayWireMessage
			_ = json.Unmarshal(bytes.TrimSpace(line), &msg)
			r.mu.Lock()
			if msg.Method == "initialize" {
				r.initialize = append([]byte(nil), line...)
			}
			if msg.Method == "notifications/initialized" {
				r.initialized = append([]byte(nil), line...)
			}
			r.queued = append(r.queued, queuedRelayMessage{data: append([]byte(nil), line...), pass: msg.Method == "" || msg.Method == "notifications/cancelled" || msg.Method == "initialize" || msg.Method == "notifications/initialized", initialized: msg.Method == "notifications/initialized"})
			r.signal()
			r.mu.Unlock()
		}
		if err != nil {
			r.mu.Lock()
			r.inputEOF = true
			r.signal()
			r.mu.Unlock()
			return
		}
	}
}

// A single writer serializes business messages and control acknowledgements.
// No socket write holds mu, so server output can always be drained concurrently.
func (r *controlledRelay) senderLoop() {
	for {
		r.mu.Lock()
		var action, attempt string
		var item []byte
		var initialized bool
		var count uint64
		writer := r.writer
		if len(r.controls) > 0 && (r.controls[0].kind != "pauseAck" || r.channel != MCP || r.initializedSent) {
			action, attempt = r.controls[0].kind, r.controls[0].attempt
			r.controls = r.controls[1:]
			count = r.sent
		} else if !r.switching {
			index := -1
			for i, m := range r.queued {
				if !r.paused || m.pass {
					index = i
					break
				}
			}
			if index >= 0 {
				item = r.queued[index].data
				initialized = r.queued[index].initialized
				r.queued = append(r.queued[:index], r.queued[index+1:]...)
			} else if r.inputEOF && len(r.queued) == 0 && (!r.paused || r.channel == MCP && !r.initializedSent) {
				action = "end"
			}
		}
		r.mu.Unlock()
		if action == "" && item == nil {
			select {
			case <-r.wake:
			case <-r.done:
				return
			}
			continue
		}
		var err error
		switch action {
		case "pauseAck":
			err = writer.control(map[string]any{"type": "pauseAck", "sentMessageCount": count, "attempt": attempt})
		case "drainedAck":
			err = writer.control(map[string]any{"type": "drainedAck", "attempt": attempt})
		case "end":
			err = writer.end()
		default:
			_, err = writer.Write(item)
		}
		if err != nil {
			select {
			case r.sendError <- err:
			default:
			}
			if closer, ok := writer.w.(io.Closer); ok {
				_ = closer.Close()
			}
			return
		}
		r.mu.Lock()
		if item != nil {
			r.sent++
			if initialized {
				r.initializedSent = true
			}
		}
		r.mu.Unlock()
		if action == "end" {
			return
		}
	}
}
func (r *controlledRelay) control(data []byte) error {
	var command struct {
		Type    string `json:"type"`
		Attempt string `json:"attempt"`
	}
	if json.Unmarshal(data, &command) != nil {
		return errors.New("native relay control invalid")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	switch command.Type {
	case "pause":
		if command.Attempt == "" {
			return errors.New("native relay control invalid")
		}
		r.attempt = command.Attempt
		r.paused = true
		r.controls = append(r.controls, relayControlMessage{kind: "pauseAck", attempt: command.Attempt})
	case "resume":
		if command.Attempt != r.attempt {
			return nil
		}
		r.paused = false
		r.switching = false
		r.drained = false
	case "drained":
		if command.Attempt != r.attempt {
			return nil
		}
		r.drained = true
		r.switching = true
		r.controls = append(r.controls, relayControlMessage{kind: "drainedAck", attempt: command.Attempt})
	default:
		return errors.New("native relay control invalid")
	}
	r.signal()
	return nil
}

// observeOutput records only the negotiated MCP protocol, not message bodies.
func (r *controlledRelay) observeOutput(p []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, _ = r.outputBuffer.Write(p)
	for {
		line, err := r.outputBuffer.ReadBytes('\n')
		if err != nil {
			_, _ = r.outputBuffer.Write(line)
			return
		}
		var initial relayWireMessage
		var response struct {
			ID     json.RawMessage `json:"id"`
			Result struct {
				ProtocolVersion string `json:"protocolVersion"`
			} `json:"result"`
		}
		if r.protocolVersion == "" && json.Unmarshal(bytes.TrimSpace(r.initialize), &initial) == nil && json.Unmarshal(line, &response) == nil && response.Result.ProtocolVersion != "" && relayID(initial.ID) != "" && relayID(response.ID) == relayID(initial.ID) {
			r.protocolVersion = response.Result.ProtocolVersion
		}
	}
}
