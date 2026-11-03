package nativebridge

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync"
)

type bufferedConn struct {
	net.Conn
	reader      *bufio.Reader
	writeMu     sync.Mutex
	writeClosed bool
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }
func (c *bufferedConn) Write(p []byte) (int, error) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeClosed {
		return 0, io.ErrClosedPipe
	}
	written := 0
	for len(p) > 0 {
		size := len(p)
		if size > 1024*1024 {
			size = 1024 * 1024
		}
		var header [4]byte
		binary.BigEndian.PutUint32(header[:], uint32(size))
		if _, e := c.Conn.Write(header[:]); e != nil {
			return written, e
		}
		chunk := p[:size]
		for len(chunk) > 0 {
			n, e := c.Conn.Write(chunk)
			written += n
			chunk = chunk[n:]
			if e != nil {
				return written, e
			}
			if n == 0 {
				return written, io.ErrShortWrite
			}
		}
		p = p[size:]
	}
	return written, nil
}
func (c *bufferedConn) CloseWrite() error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.writeClosed {
		return nil
	}
	c.writeClosed = true
	_, err := c.Conn.Write([]byte{0, 0, 0, 0})
	return err
}

type frameReader struct {
	reader    io.Reader
	remaining uint32
	ended     bool
}

func (f *frameReader) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if f.ended {
		return 0, io.EOF
	}
	if f.remaining == 0 {
		var header [4]byte
		if _, e := io.ReadFull(f.reader, header[:]); e != nil {
			return 0, e
		}
		f.remaining = binary.BigEndian.Uint32(header[:])
		if f.remaining == 0 {
			f.ended = true
			return 0, io.EOF
		}
		if f.remaining > 1024*1024 {
			return 0, errors.New("native service frame too large")
		}
	}
	if uint32(len(p)) > f.remaining {
		p = p[:f.remaining]
	}
	n, e := f.reader.Read(p)
	f.remaining -= uint32(n)
	return n, e
}
