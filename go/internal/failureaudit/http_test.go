package failureaudit

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"github.com/google/uuid"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func receive(t *testing.T, events <-chan Event) Event {
	t.Helper()
	select {
	case e := <-events:
		return e
	case <-time.After(3 * time.Second):
		t.Fatal("missing observed failure")
		return Event{}
	}
}
func TestActualHTTPStatusActorOnceAndFinalWireRequestID(t *testing.T) {
	events := make(chan Event, 8)
	finalID := uuid.NewString()
	initialID := ""
	observer := HTTPObserver{Record: func(ctx context.Context, e Event) string {
		if ctx.Err() != nil {
			t.Error("record got canceled context")
		}
		events <- e
		return "queued"
	}}
	auth := Authentication{Version: 1, ClientID: uuid.NewString(), Audience: "https://fixture.invalid", Scope: "binding", BindingScopes: []string{"binding"}, CredentialScopes: []string{"binding"}}
	server := httptest.NewServer(observer.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		initialID = w.Header().Get("X-Request-Id")
		if r.Header.Get("X-Request-Id") == initialID {
			t.Error("client request ID trusted")
		}
		actor := Actor{SubjectID: "GUID" + strings.Repeat("A", 28), BindingID: uuid.NewString(), Authentication: &auth}
		if !CaptureActor(context.WithValue(r.Context(), struct{}{}, true), actor) {
			t.Error("trusted actor not propagated")
		}
		auth.BindingScopes[0] = "untrusted-mutation"
		bad := actor
		bad.SubjectID = "PRIVATE-UNVERIFIED"
		if CaptureActor(r.Context(), bad) {
			t.Error("invalid actor accepted")
		}
		w.Header().Set("X-Request-Id", finalID)
		w.WriteHeader(429)
		w.Header().Set("X-Request-Id", uuid.NewString())
		w.WriteHeader(500)
		io.WriteString(w, "PRIVATE-RESPONSE-BODY")
	})))
	defer server.Close()
	req, _ := http.NewRequest("GET", server.URL+"/v1/cases?token=PRIVATE-QUERY", nil)
	req.Header.Set("X-Request-Id", uuid.NewString())
	req.Header.Set("Authorization", "Bearer PRIVATE-TOKEN")
	response, e := server.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	event := receive(t, events)
	if response.StatusCode != 429 || string(body) != "PRIVATE-RESPONSE-BODY" || event.Status != 429 || event.RequestID != finalID || response.Header.Get("X-Request-Id") != event.RequestID || event.Route != "GET /v1/cases" || event.Actor == nil || event.Actor.Authentication.BindingScopes[0] != "binding" || initialID == finalID {
		t.Fatal("wire/status/actor changed", event)
	}
	select {
	case extra := <-events:
		t.Fatal("duplicate", extra)
	default:
	}
	if strings.Contains(encode(event), "PRIVATE") || strings.Contains(encode(event), "untrusted") {
		t.Fatal("private data captured")
	}
	if CaptureActor(context.Background(), Actor{}) {
		t.Fatal("actor without request observer")
	}
}
func TestActualSSEFlushDisconnect499AndHijack(t *testing.T) {
	events := make(chan Event, 8)
	finished := make(chan struct{})
	var captured atomic.Bool
	observer := HTTPObserver{Record: func(ctx context.Context, e Event) string {
		if ctx.Err() != nil {
			t.Error("disconnect canceled durable commit")
		}
		events <- e
		return "queued"
	}}
	server := httptest.NewServer(observer.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/hijack" {
			conn, rw, e := w.(http.Hijacker).Hijack()
			if e != nil {
				t.Error(e)
				return
			}
			rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n")
			rw.Flush()
			conn.Close()
			return
		}
		defer close(finished)
		captured.Store(CaptureActor(r.Context(), Actor{SubjectID: "GUID" + strings.Repeat("B", 28), BindingID: uuid.NewString()}))
		if _, ok := w.(http.Flusher); !ok {
			t.Error("SSE Flusher lost")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "event: fixture\ndata: first\n\n")
		if e := http.NewResponseController(w).Flush(); e != nil {
			t.Error(e)
			return
		}
		<-r.Context().Done()
		w.WriteHeader(500)
		io.WriteString(w, "late failed write")
	})))
	defer server.Close()
	response, e := server.Client().Get(server.URL + "/v1/builders/events")
	if e != nil {
		t.Fatal(e)
	}
	line, e := bufio.NewReader(response.Body).ReadString('\n')
	if e != nil || line != "event: fixture\n" {
		t.Fatal("SSE was buffered", line, e)
	}
	wireID := response.Header.Get("X-Request-Id")
	response.Body.Close()
	event := receive(t, events)
	if event.Status != 499 || event.RequestID != wireID || event.Route != "GET /v1/builders/events" || event.Actor == nil || !captured.Load() {
		t.Fatal("disconnect/actor", event)
	}
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("handler did not finish")
	}
	conn, e := net.Dial("tcp", server.Listener.Addr().String())
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	conn.Write([]byte("GET /hijack HTTP/1.1\r\nHost: fixture.invalid\r\n\r\n"))
	result, e := http.ReadResponse(bufio.NewReader(conn), nil)
	if e != nil || result.StatusCode != 101 {
		t.Fatal("hijack failed", e)
	}
	result.Body.Close()
	select {
	case extra := <-events:
		t.Fatal("duplicate failure or hijack incorrectly audited", extra)
	default:
	}
}

type capableWriter struct {
	header                           http.Header
	body                             bytes.Buffer
	readCalls, pushCalls, flushCalls int
	deadline                         bool
	closeNotify                      chan bool
}

func (w *capableWriter) Header() http.Header         { return w.header }
func (w *capableWriter) WriteHeader(int)             {}
func (w *capableWriter) Write(v []byte) (int, error) { return w.body.Write(v) }
func (w *capableWriter) ReadFrom(r io.Reader) (int64, error) {
	w.readCalls++
	return w.body.ReadFrom(r)
}
func (w *capableWriter) Flush() { w.flushCalls++ }
func (w *capableWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, http.ErrNotSupported
}
func (w *capableWriter) Push(string, *http.PushOptions) error { w.pushCalls++; return nil }
func (w *capableWriter) CloseNotify() <-chan bool             { return w.closeNotify }
func (w *capableWriter) SetWriteDeadline(time.Time) error     { w.deadline = true; return nil }

type plainWriter struct{ header http.Header }

func (w *plainWriter) Header() http.Header         { return w.header }
func (w *plainWriter) WriteHeader(int)             {}
func (w *plainWriter) Write(p []byte) (int, error) { return len(p), nil }
func TestResponseCapabilitiesReaderFromUnwrapAndPlainContentType(t *testing.T) {
	observer := HTTPObserver{}
	handler := observer.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			t.Error("flush missing")
		}
		if _, ok := w.(http.Hijacker); !ok {
			t.Error("hijacker missing")
		}
		if _, ok := w.(io.ReaderFrom); !ok {
			t.Error("readerFrom missing")
		}
		w.(http.Pusher).Push("/fixture", nil)
		if w.(http.CloseNotifier).CloseNotify() == nil {
			t.Error("close notifier lost")
		}
		if e := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(time.Second)); e != nil {
			t.Error(e)
		}
		io.Copy(w, io.LimitReader(strings.NewReader("exact stream bytes"), 100))
		w.(http.Flusher).Flush()
	}))
	full := &capableWriter{header: http.Header{}, closeNotify: make(chan bool)}
	handler.ServeHTTP(full, httptest.NewRequest("GET", "http://fixture.invalid/stream", nil))
	if full.body.String() != "exact stream bytes" || full.readCalls != 1 || full.pushCalls != 1 || full.flushCalls != 1 || !full.deadline {
		t.Fatal("capability delegation changed", full)
	}
	observer.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := w.(http.Flusher); ok {
			t.Error("invented Flusher")
		}
		if _, ok := w.(http.Hijacker); ok {
			t.Error("invented Hijacker")
		}
		if _, ok := w.(io.ReaderFrom); ok {
			t.Error("invented ReaderFrom")
		}
		if e := http.NewResponseController(w).Flush(); !errors.Is(e, http.ErrNotSupported) {
			t.Error("unsupported flush", e)
		}
	})).ServeHTTP(&plainWriter{header: http.Header{}}, httptest.NewRequest("GET", "http://fixture.invalid/", nil))
	server := httptest.NewServer(observer.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "original plain text") })))
	defer server.Close()
	response, e := server.Client().Get(server.URL)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.Header.Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatal("implicit content sniffing changed", response.Header)
	}
}

func TestActualTCPImplicitContentTypesMatchWithoutObserver(t *testing.T) {
	for name, body := range map[string][]byte{"html": []byte("<!doctype html><html><body>original</body></html>"), "text": []byte("plain original text"), "binary": {0, 1, 2, 3, 0xff, 0, 0x80}} {
		for _, readFrom := range []bool{false, true} {
			t.Run(name+map[bool]string{false: "/Write", true: "/ReadFrom"}[readFrom], func(t *testing.T) {
				handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if readFrom {
						io.Copy(w, io.LimitReader(bytes.NewReader(body), int64(len(body))))
					} else {
						w.Write(body)
					}
				})
				var contentType, contentLength string
				for _, observed := range []bool{false, true} {
					var next http.Handler = handler
					if observed {
						next = (HTTPObserver{}).Middleware(next)
					}
					server := httptest.NewServer(next)
					conn, e := net.Dial("tcp", server.Listener.Addr().String())
					if e != nil {
						t.Fatal(e)
					}
					conn.Write([]byte("GET / HTTP/1.1\r\nHost: fixture.invalid\r\nConnection: close\r\n\r\n"))
					response, e := http.ReadResponse(bufio.NewReader(conn), nil)
					if e != nil {
						t.Fatal(e)
					}
					got, e := io.ReadAll(response.Body)
					response.Body.Close()
					conn.Close()
					server.Close()
					if e != nil || !bytes.Equal(got, body) || response.StatusCode != 200 {
						t.Fatal("wire body/status changed", e)
					}
					if !observed {
						contentType = response.Header.Get("Content-Type")
						contentLength = response.Header.Get("Content-Length")
					} else if response.Header.Get("Content-Type") != contentType || response.Header.Get("Content-Length") != contentLength {
						t.Fatalf("implicit response changed: %s/%s vs %s/%s", response.Header.Get("Content-Type"), response.Header.Get("Content-Length"), contentType, contentLength)
					}
				}
			})
		}
	}
}

type shortWriter struct{ header http.Header }

func (w *shortWriter) Header() http.Header         { return w.header }
func (w *shortWriter) WriteHeader(int)             {}
func (w *shortWriter) Write(p []byte) (int, error) { return 3, io.ErrShortWrite }
func TestHTTPCompletionActualShortWriteAndConsumedBodyOnly(t *testing.T) {
	completed := make(chan HTTPCompletion, 4)
	diagnostics := make(chan HTTPDiagnostic, 8)
	observer := HTTPObserver{BeginHTTP: func() func(HTTPCompletion) { return func(v HTTPCompletion) { completed <- v } }, Logger: func(v HTTPDiagnostic) { diagnostics <- v }}
	short := &shortWriter{header: http.Header{}}
	observer.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, e := w.Write([]byte("long response"))
		if n != 3 || e != io.ErrShortWrite {
			t.Error("short write semantics changed")
		}
	})).ServeHTTP(short, httptest.NewRequest("GET", "http://fixture.invalid/v1/cases", nil))
	value := <-completed
	if value.BodyBytes != 3 || value.Status != 499 {
		t.Fatal("short write metric", value)
	}
	server := httptest.NewServer(observer.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rejected" {
			w.WriteHeader(401)
			return
		}
		data := make([]byte, 3)
		io.ReadFull(r.Body, data)
		io.Copy(w, io.LimitReader(strings.NewReader("eight123"), 8))
	})))
	defer server.Close()
	for _, path := range []string{"/v1/cases", "/rejected"} {
		response, e := server.Client().Post(server.URL+path, "text/plain", strings.NewReader("PRIVATE-UNREAD-REMAINDER"))
		if e != nil {
			t.Fatal(e)
		}
		io.Copy(io.Discard, response.Body)
		response.Body.Close()
		value = <-completed
		if path == "/rejected" {
			if value.ReceivedBodyBytes != 0 || value.BodyBytes != 0 || value.Status != 401 {
				t.Fatal("unread body counted", value)
			}
		} else if value.ReceivedBodyBytes != 3 || value.BodyBytes != 8 || value.Status != 200 {
			t.Fatal("actual consumed/stream bytes", value)
		}
	}
	select {
	case extra := <-completed:
		t.Fatal("duplicate completion", extra)
	default:
	}
	found := 0
	for len(diagnostics) > 0 {
		d := <-diagnostics
		if d.Event == "http_completed" {
			found++
			if d.DurationMS < 0 || d.RequestID == "" {
				t.Fatal("completion diagnostic missing", d)
			}
		}
	}
	if found != 3 {
		t.Fatal("completion logging", found)
	}
}
