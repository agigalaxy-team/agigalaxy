package native

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/summaries"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
)

type summaryPreferenceDispatchGate struct {
	next    http.RoundTripper
	blocked atomic.Bool
}

func (g *summaryPreferenceDispatchGate) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Path == "/v2/personal-summaries/preferences/save" && g.blocked.Load() {
		return nil, io.ErrUnexpectedEOF
	}
	return g.next.RoundTrip(request)
}

// The real summary preference endpoint commits before the transport drops its
// reply. A later remote change must not be overwritten by replay at a new revision.
func TestPersonalSummaryPreferenceLostReplyAndConcurrentChange(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	original, err := url.Parse(meta.Origin)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(summaries.Handler{Service: &summaries.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now}, Next: httputil.NewSingleHostReverseProxy(original)})
	defer server.Close()
	transport.origin, err = url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	gate := &summaryPreferenceDispatchGate{next: transport}
	rt, err := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: gate}, Now: now})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()
	if _, err = rt.connection.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	h := NewNativePersonalSummaries(rt)
	defer h.Close()
	op, cancel, lease, err := h.begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	if lease.connection == nil {
		t.Fatal("fixture binding missing")
	}
	var saves atomic.Int32
	var drop atomic.Bool
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/personal-summaries/preferences/save" {
			saves.Add(1)
			if drop.Swap(false) {
				response.Body.Close()
				return nil, io.ErrUnexpectedEOF
			}
		}
		return response, nil
	})
	choose := func(enabled bool) {
		t.Helper()
		if _, err := h.choose(op, lease, map[string]any{"enabled": enabled, "roomIds": nil, "includeExisting": true}, &lease.scope); err != nil {
			t.Fatal(err)
		}
	}
	choose(true)
	drop.Store(true)
	result, err := h.synchronize(op, lease, true)
	if err != nil || result["state"] != "preference-unknown" || saves.Load() != 1 {
		t.Fatalf("lost reply: %#v %v saves=%d", result, err, saves.Load())
	}
	result, err = h.synchronize(op, lease, true)
	if err != nil || saves.Load() != 1 {
		t.Fatalf("matching remote preference replayed: %#v %v saves=%d", result, err, saves.Load())
	}
	state, err := lease.read(op)
	if err != nil || state["preferenceOperation"] != nil || psInt(psObject(state["preference"])["cloudRevision"]) != 1 {
		t.Fatalf("committed preference not reconciled: %#v %v", state, err)
	}
	choose(false)
	drop.Store(true)
	result, err = h.synchronize(op, lease, true)
	if err != nil || result["state"] != "preference-unknown" || saves.Load() != 2 {
		t.Fatalf("second lost reply: %#v %v", result, err)
	}
	// A separate later write advances the exact shared revision.
	if _, err = lease.call(op, "preferences/save", map[string]any{"endpoint": meta.Configuration.Endpoint, "expectedRevision": 2, "enabled": true, "roomIds": nil, "includeExisting": true}); err != nil {
		t.Fatal(err)
	}
	result, err = h.synchronize(op, lease, true)
	if err != nil || result["state"] != "preference-conflict" || saves.Load() != 3 {
		t.Fatalf("later preference overwritten: %#v %v saves=%d", result, err, saves.Load())
	}
	result, err = h.synchronize(op, lease, true)
	if err != nil || result["state"] != "preference-conflict" || saves.Load() != 3 {
		t.Fatalf("conflict was replayed: %#v %v", result, err)
	}
	choose(false)
	result, err = h.synchronize(op, lease, true)
	if err != nil || saves.Load() != 4 {
		t.Fatalf("new explicit choice did not continue: %#v %v saves=%d", result, err, saves.Load())
	}
	choose(true)
	gate.blocked.Store(true)
	result, err = h.synchronize(op, lease, true)
	if err != nil || result["state"] != "preference-unknown" || saves.Load() != 4 {
		t.Fatalf("interrupted preference dispatch: %#v %v", result, err)
	}
	gate.blocked.Store(false)
	result, err = h.synchronize(op, lease, true)
	if err != nil || result["state"] == "preference-unknown" || saves.Load() != 5 {
		t.Fatalf("original compare-and-set did not resume: %#v %v saves=%d", result, err, saves.Load())
	}
	choose(false)
	gate.blocked.Store(true)
	if result, err = h.synchronize(op, lease, true); err != nil || result["state"] != "preference-unknown" {
		t.Fatalf("original compare-and-set was not retained: %#v %v", result, err)
	}
	state, err = lease.read(op)
	if err != nil {
		t.Fatal(err)
	}
	originalInput := psObject(psObject(state["preferenceOperation"])["input"])
	choose(true)
	gate.blocked.Store(false)
	// Model the delayed original request winning before the newer choice.
	if _, err = lease.call(op, "preferences/save", originalInput); err != nil {
		t.Fatal(err)
	}
	if result, err = h.synchronize(op, lease, true); err != nil || saves.Load() != 7 {
		t.Fatalf("newer reviewed choice did not follow the original CAS: %#v %v saves=%d", result, err, saves.Load())
	}
}
