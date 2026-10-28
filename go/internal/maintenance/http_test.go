package maintenance

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type observedBody struct{ reads int }

func (b *observedBody) Read([]byte) (int, error) { b.reads++; return 0, io.EOF }
func (b *observedBody) Close() error             { return nil }
func TestMaintenancePrivateHTTPAndRouteBoundary(t *testing.T) {
	now := func() time.Time { return time.Unix(2000000000, 0) }
	var handler Handler
	client := New(Configuration{SocketPath: "/run/galaxy-maintenance/api.sock", Key: strings.Repeat("k", 40)}, Options{Now: now, Transport: maintenanceTransport{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) })}})
	handler = Handler{Service: &Service{ChatProbe: func(context.Context) (Object, error) {
		return Object{"authenticatedGateway": true, "roomsDomain": "rooms.galaxy.internal", "roundTrip": true, "readOnly": true, "bodyReturned": false, "extra": "private"}, nil
	}}, Native: &NativeClient{Client: client}}
	for _, remote := range []string{"192.0.2.1:9", "127.0.0.1:9"} {
		body := &observedBody{}
		r := httptest.NewRequest("POST", "http://api.invalid/v1/internal/maintenance/chat-probe", nil)
		r.RemoteAddr = remote
		r.Body = body
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 401 || body.reads != 0 {
			t.Fatalf("body read before private authorization %s status%d reads%d", remote, w.Code, body.reads)
		}
	}
	raw := []byte(`{"version":1,"kind":"prosody-current-state","operationId":null}`)
	out, status, e := client.call(context.Background(), "/v1/internal/maintenance/chat-probe", raw, 65536, time.Second)
	if e != nil || status != 200 || strings.Contains(string(out), "extra") {
		t.Fatalf("actual signed chat probe %d %s %v", status, out, e)
	}
	handler.Service.ChatProbe = func(context.Context) (Object, error) {
		return Object{"authenticatedGateway": true, "roomsDomain": "wrong.internal", "roundTrip": true, "readOnly": true, "bodyReturned": false}, nil
	}
	_, status, e = client.call(context.Background(), "/v1/internal/maintenance/chat-probe", raw, 65536, time.Second)
	if e != nil || status != 503 {
		t.Fatalf("unconfirmed probe accepted %d %v", status, e)
	}
	for _, path := range []string{"/v1/operations/maintenance", "/v1/operations/maintenance/no-such-route"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 {
			t.Fatalf("added unsupported route %s %d", path, w.Code)
		}
	}
	r := httptest.NewRequest("GET", "/v1/operations/maintenance/logs?limit=1&limit=2", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatal("duplicate query accepted")
	}
}
