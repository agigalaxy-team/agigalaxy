package nativebridge

import (
	"bytes"
	"encoding/json"
	"sync"
)

// relayDrainState tracks complete protocol messages at the IPC boundary. It
// never retains arguments or results, and never retries a business request.
type relayDrainState struct {
	mu           sync.Mutex
	writer       *relayPacketWriter
	inputCalls   map[string]bool
	outputCalls  map[string]bool
	readMessages uint64
	attempt      string
	pauseSent    uint64
	paused       bool
	drained      bool
	ready        bool
	closed       bool
	changed      chan struct{}
	output       bytes.Buffer
}

func newRelayDrainState(w *relayPacketWriter) *relayDrainState {
	return &relayDrainState{writer: w, inputCalls: map[string]bool{}, outputCalls: map[string]bool{}, changed: make(chan struct{}, 1)}
}
func (s *relayDrainState) signal() {
	select {
	case s.changed <- struct{}{}:
	default:
	}
}

type relayWireMessage struct {
	ID     json.RawMessage `json:"id"`
	Method string          `json:"method"`
}

func relayID(id json.RawMessage) string {
	if len(id) == 0 || bytes.Equal(id, []byte("null")) {
		return ""
	}
	return string(id)
}
func (s *relayDrainState) incoming(line []byte) {
	var m relayWireMessage
	valid := json.Unmarshal(line, &m) == nil
	id := relayID(m.ID)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.readMessages++
	if !valid {
		s.signal()
		return
	}
	if id != "" {
		if m.Method != "" {
			s.inputCalls[id] = true
		} else {
			delete(s.outputCalls, id)
		}
	}
	s.signal()
}

// outputWrite is called only after the serialized bytes were written to the
// relay; the later drained acknowledgement is the stdout-delivery barrier.
func (s *relayDrainState) outputWrite(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.writer.Write(p); err != nil {
		return 0, err
	}
	_, _ = s.output.Write(p)
	for {
		line, err := s.output.ReadBytes('\n')
		if err != nil {
			_, _ = s.output.Write(line)
			break
		}
		var m relayWireMessage
		if json.Unmarshal(line, &m) != nil {
			continue
		}
		id := relayID(m.ID)
		if id != "" {
			if m.Method != "" {
				s.outputCalls[id] = true
			} else {
				delete(s.inputCalls, id)
			}
		}
	}
	s.signal()
	return len(p), nil
}
func (s *relayDrainState) safe() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return (s.closed || s.paused && s.readMessages >= s.pauseSent) && len(s.inputCalls) == 0 && len(s.outputCalls) == 0
}
