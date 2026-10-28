package failureaudit

import (
	"context"
	"sync"
	"time"
)

type observerKey struct{}
type requestObserver struct {
	mu                           sync.Mutex
	actor                        *Actor
	requestID, route             string
	recorded, complete, hijacked bool
	record                       func(context.Context, Event) string
	logger                       func(HTTPDiagnostic)
	now                          func() time.Time
	started                      time.Time
	bodyBytes, receivedBodyBytes int64
	metricDone                   bool
	metric                       func(HTTPCompletion)

	method, path string
}

// CaptureActor must be called only after successful authentication. It selects
// the public authentication-time snapshot; headers never establish an actor.
// The observer is shared through derived request contexts, so inner handlers can
// report success to the outer HTTP middleware without mutating a context value.
func CaptureActor(ctx context.Context, actor Actor) bool {
	o, ok := ctx.Value(observerKey{}).(*requestObserver)
	if !ok {
		return false
	}
	event, e := normalize(Event{RequestID: "00000000-0000-0000-0000-000000000000", Status: 400, Route: "http.request", Actor: &actor}, time.Now())
	if e != nil {
		return false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.recorded || o.complete {
		return false
	}
	o.actor = event.Actor
	return true
}
func (o *requestObserver) finish(status int) {
	o.mu.Lock()
	if o.recorded || o.complete || o.hijacked || status < 400 || status > 599 {
		o.mu.Unlock()
		return
	}
	o.recorded = true
	event := Event{RequestID: o.requestID, Status: status, Route: o.route, Actor: o.actor, ObservedAt: o.now().UTC().Format("2006-01-02T15:04:05.000Z")}
	o.mu.Unlock()
	auditStatus := "unavailable"
	if o.record != nil {
		auditStatus = func() (out string) {
			out = "failed"
			defer func() { _ = recover() }()
			return o.record(context.Background(), event)
		}()
	}
	// Callback output is also finite: a custom recorder cannot smuggle backend
	// messages into diagnostics by returning its raw error as a status string.
	switch auditStatus {
	case "queued", "recorded", "suppressed-by-deletion", "capacity", "unconfirmed", "failed", "closed", "unavailable":
	default:
		auditStatus = "failed"
	}
	if o.logger != nil {
		func() {
			defer func() { _ = recover() }()
			o.logger(HTTPDiagnostic{Event: "http_rejected", RequestID: event.RequestID, Status: status, Route: event.Route, AuditStatus: auditStatus})
		}()
	}
}

func (o *requestObserver) completeHTTP(status int) {
	o.mu.Lock()
	if o.metricDone {
		o.mu.Unlock()
		return
	}
	o.metricDone = true
	value := HTTPCompletion{Method: o.method, Path: o.path, Status: status, BodyBytes: o.bodyBytes, ReceivedBodyBytes: o.receivedBodyBytes}
	requestID, route := o.requestID, o.route
	duration := float64(time.Since(o.started)) / float64(time.Millisecond)
	o.mu.Unlock()
	if o.metric != nil {
		func() { defer func() { _ = recover() }(); o.metric(value) }()
	}
	if o.logger != nil {
		func() {
			defer func() { _ = recover() }()
			o.logger(HTTPDiagnostic{Event: "http_completed", RequestID: requestID, Status: status, Route: route, DurationMS: duration})
		}()
	}
}
