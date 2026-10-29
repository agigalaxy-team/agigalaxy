package native

import (
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeRecoverySameIdentityOriginalReceipt(t *testing.T) {
	ctx := context.Background()
	store, meta, transport := connectionServiceFixture(t)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	original, e := runtime.Restore(ctx)
	if e != nil {
		t.Fatal(e)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	recovery := NewNativeRecovery(runtime)
	prepared, e := recovery.PrepareSet(ctx, &scope)
	if e != nil {
		t.Fatal("prepare set", e)
	}
	setID := text(prepared["operationId"])
	code, e := recovery.codeForLocalDisplay(ctx, setID)
	if e != nil {
		t.Fatal("local display", e)
	}
	if _, e = recovery.ConfirmSet(ctx, setID, &scope); e != nil {
		t.Fatal("set recovery", e)
	}
	var sent atomic.Int32
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/identity/control/commit" {
			sent.Add(1)
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	pending, e := recovery.RecoverReviewed(ctx, code, &scope)
	if e == nil || text(pending["operationId"]) == "" || sent.Load() != 1 {
		t.Fatal("lost recover acknowledgment", pending, e)
	}
	id := text(pending["operationId"])
	transport.setHook(nil)
	recovered, e := recovery.Reconcile(ctx, id)
	if e != nil {
		t.Fatal("reconcile recovery", e)
	}
	if recovered["subjectId"] != original.SubjectID || recovered["connectionRequired"] != true || sent.Load() != 1 {
		t.Fatal("recovery selection", recovered)
	}
	nextScope, e := store.ChoiceScope(ctx)
	if e != nil || nextScope.Owner != original.SubjectID || nextScope.DeviceID == scope.DeviceID {
		t.Fatal("same identity new device", nextScope, e)
	}
	nextCode, e := recovery.codeForLocalDisplay(ctx, id)
	if e != nil || nextCode == code {
		t.Fatal("replacement recovery material", e)
	}
	if _, e = recovery.ConfirmNextSaved(ctx, id, &nextScope); e != nil {
		t.Fatal("declare saved", e)
	}
	state, e := recovery.Reconcile(ctx, id)
	if e != nil || state["state"] != "registered" {
		t.Fatal("original receipt", state, e)
	}
}
