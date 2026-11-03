package nativebridge

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

// relayPacket is internal IPC framing negotiated separately from MCP.
type relayPacket struct {
	Kind byte
	Data []byte
}

var errRelayInputEnded = errors.New("native relay input ended")

const (
	relayData        byte = 1
	relayControl     byte = 2
	relayPacketLimit      = 1024 * 1024
)

type relayPacketWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (w *relayPacketWriter) packet(kind byte, data []byte) error {
	if len(data) > relayPacketLimit {
		return errors.New("native relay packet too large")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	var h [5]byte
	binary.BigEndian.PutUint32(h[:4], uint32(len(data)+1))
	h[4] = kind
	if err := writeAll(w.w, h[:]); err != nil {
		return err
	}
	return writeAll(w.w, data)
}
func (w *relayPacketWriter) control(value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	return w.packet(relayControl, b)
}
func (w *relayPacketWriter) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		n := len(p)
		if n > relayPacketLimit {
			n = relayPacketLimit
		}
		if err := w.packet(relayData, p[:n]); err != nil {
			return total, err
		}
		total += n
		p = p[n:]
	}
	return total, nil
}
func readRelayPacket(r io.Reader) (relayPacket, error) {
	var h [4]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		return relayPacket{}, err
	}
	n := binary.BigEndian.Uint32(h[:])
	if n == 0 {
		return relayPacket{}, errRelayInputEnded
	}
	if n > relayPacketLimit+1 {
		return relayPacket{}, errors.New("native relay packet too large")
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r, b); err != nil {
		return relayPacket{}, err
	}
	if b[0] != relayData && b[0] != relayControl {
		return relayPacket{}, errors.New("native relay packet invalid")
	}
	return relayPacket{Kind: b[0], Data: b[1:]}, nil
}
func writeAll(w io.Writer, p []byte) error {
	for len(p) > 0 {
		n, e := w.Write(p)
		if e != nil {
			return e
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		p = p[n:]
	}
	return nil
}

func (w *relayPacketWriter) end() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return writeAll(w.w, []byte{0, 0, 0, 0})
}
