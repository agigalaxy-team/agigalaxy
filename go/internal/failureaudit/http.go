package failureaudit

import (
	"bufio"
	"context"
	"github.com/google/uuid"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

type HTTPCompletion struct {
	Method, Path                 string
	Status                       int
	BodyBytes, ReceivedBodyBytes int64
}
type HTTPDiagnostic struct {
	Event       string  `json:"event"`
	RequestID   string  `json:"requestId"`
	Status      int     `json:"status"`
	Route       string  `json:"route"`
	AuditStatus string  `json:"auditStatus,omitempty"`
	DurationMS  float64 `json:"durationMs"`
}
type HTTPObserver struct {
	Record    func(context.Context, Event) string
	Now       func() time.Time
	Logger    func(HTTPDiagnostic)
	BeginHTTP func() func(HTTPCompletion)
}

// Middleware observes the actual outer response status without reading or
// retaining its body. Place it outside quota, browser and domain handlers.
func (h HTTPObserver) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		now := h.Now
		if now == nil {
			now = time.Now
		}
		id := uuid.NewString()
		w.Header().Set("X-Request-Id", id)
		o := &requestObserver{requestID: id, route: FailureRoute(r.Method, r.URL.Path), record: h.Record, logger: h.Logger, now: now}
		r = r.WithContext(context.WithValue(r.Context(), observerKey{}, o))
		o.method = r.Method
		o.path = r.URL.Path
		o.started = time.Now()
		if h.BeginHTTP != nil {
			o.metric = h.BeginHTTP()
		}
		if r.Body != nil {
			r.Body = &observedBody{ReadCloser: r.Body, observer: o}
		}
		response := &observedResponse{underlying: w, observer: o}
		stop := context.AfterFunc(r.Context(), func() { o.finish(499); o.completeHTTP(499) })
		defer func() {
			stop()
			if value := recover(); value != nil { // Preserve net/http's own panic/abort semantics.
				o.finish(499)
				o.completeHTTP(499)
				o.mu.Lock()
				o.complete = true
				o.mu.Unlock()
				panic(value)
			}
			response.mu.Lock()
			status := response.status
			response.mu.Unlock()
			if status == 0 {
				status = 200
			}
			if r.Context().Err() != nil {
				o.finish(499)
				status = 499
			}
			o.completeHTTP(status)
			o.mu.Lock()
			o.complete = true
			o.mu.Unlock()
		}()

		next.ServeHTTP(preserveResponseCapabilities(response), r)
	})
}

type observedResponse struct {
	underlying http.ResponseWriter
	observer   *requestObserver
	mu         sync.Mutex
	wroteFinal bool
	status     int
}

func (w *observedResponse) Header() http.Header         { return w.underlying.Header() }
func (w *observedResponse) Unwrap() http.ResponseWriter { return w.underlying }
func (w *observedResponse) commit(status int) bool {
	w.mu.Lock()
	if w.wroteFinal {
		w.mu.Unlock()
		return false
	}
	if status >= 100 && status < 200 && status != 101 {
		w.mu.Unlock()
		return true
	}
	w.wroteFinal = true
	w.status = status
	id := w.Header().Get("X-Request-Id")
	if !eventUUID.MatchString(id) {
		id = uuid.NewString()
		w.Header().Set("X-Request-Id", id)
	}
	w.observer.mu.Lock()
	w.observer.requestID = id
	w.observer.mu.Unlock()
	w.mu.Unlock()
	w.observer.finish(status)
	return true
}
func (w *observedResponse) WriteHeader(status int) {
	if w.commit(status) {
		w.underlying.WriteHeader(status)
	}
}
func (w *observedResponse) Write(body []byte) (int, error) {
	w.commit(http.StatusOK)
	n, e := w.underlying.Write(body)
	w.observer.mu.Lock()
	w.observer.bodyBytes += int64(n)
	w.observer.mu.Unlock()
	if e != nil {
		w.observer.finish(499)
		w.observer.completeHTTP(499)
	}
	return n, e
}
func (w *observedResponse) flushError() error {
	if w.commit(http.StatusOK) {
		w.underlying.WriteHeader(http.StatusOK)
	}
	e := http.NewResponseController(w.underlying).Flush()
	if e != nil {
		w.observer.finish(499)
		w.observer.completeHTTP(499)
	}
	return e
}
func (w *observedResponse) hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffer, e := w.underlying.(http.Hijacker).Hijack()
	if e == nil {
		w.observer.mu.Lock()
		w.observer.hijacked = true
		w.observer.mu.Unlock()
	}
	return conn, buffer, e
}
func (w *observedResponse) readFrom(reader io.Reader) (int64, error) {
	w.commit(http.StatusOK)
	n, e := w.underlying.(io.ReaderFrom).ReadFrom(reader)
	w.observer.mu.Lock()
	w.observer.bodyBytes += n
	w.observer.mu.Unlock()
	if e != nil {
		w.observer.finish(499)
		w.observer.completeHTTP(499)
	}
	return n, e
}

type responseFlush struct{ w *observedResponse }

func (f responseFlush) Flush()            { _ = f.w.flushError() }
func (f responseFlush) FlushError() error { return f.w.flushError() }

type responseHijack struct{ w *observedResponse }

func (h responseHijack) Hijack() (net.Conn, *bufio.ReadWriter, error) { return h.w.hijack() }

type responseReadFrom struct{ w *observedResponse }

func (r responseReadFrom) ReadFrom(reader io.Reader) (int64, error) { return r.w.readFrom(reader) }

type responsePush struct{ w *observedResponse }

func (p responsePush) Push(target string, options *http.PushOptions) error {
	return p.w.underlying.(http.Pusher).Push(target, options)
}

type responseCloseNotify struct{ w *observedResponse }

func (c responseCloseNotify) CloseNotify() <-chan bool {
	return c.w.underlying.(http.CloseNotifier).CloseNotify()
}

// observedBody counts only bytes the handler consumes; it never pre-reads or
// retains request data (including bodies rejected before JSON parsing).
type observedBody struct {
	io.ReadCloser
	observer *requestObserver
}

func (b *observedBody) Read(p []byte) (int, error) {
	n, e := b.ReadCloser.Read(p)
	b.observer.mu.Lock()
	b.observer.receivedBodyBytes += int64(n)
	b.observer.mu.Unlock()
	return n, e
}
