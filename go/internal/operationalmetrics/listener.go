package operationalmetrics

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"time"
)

type Listener struct {
	server   *http.Server
	listener net.Listener
	done     chan struct{}
}

// StartListener is deliberately loopback-only, independent of the public API.
// A nil port disables it; zero is useful only for an isolated local check.
func StartListener(metrics *Metrics, port *int) (*Listener, error) {
	if port == nil {
		return nil, nil
	}
	if metrics == nil || *port < 0 || *port > 65535 {
		return nil, invalid()
	}
	socket, e := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", *port))
	if e != nil {
		return nil, invalid()
	}
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: time.Second, MaxHeaderBytes: 163840, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != "GET" || r.RequestURI != "/metrics" {
			w.WriteHeader(404)
			return
		}
		body, e := metrics.Render(r.Context())
		if e != nil {
			w.WriteHeader(503)
			w.Write([]byte("metrics unavailable\n"))
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		w.Write([]byte(body))
	})}
	result := &Listener{server: server, listener: socket, done: make(chan struct{})}
	go func() { defer close(result.done); _ = server.Serve(socket) }()
	return result, nil
}
func (l *Listener) Addr() net.Addr {
	if l == nil {
		return nil
	}
	return l.listener.Addr()
}
func (l *Listener) Close() error {
	if l == nil {
		return nil
	}
	e := l.server.Close()
	<-l.done
	return e
}
func (l *Listener) Shutdown(ctx context.Context) error {
	if l == nil {
		return nil
	}
	e := l.server.Shutdown(ctx)
	if e != nil {
		_ = l.server.Close()
	}
	<-l.done
	return e
}
