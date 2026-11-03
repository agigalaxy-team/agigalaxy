package native

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestFirstConnectRegistersLocalIdentityAndReconcilesOriginal(t *testing.T) {
	_, meta, transport := connectionServiceFixture(t)
	for _, lostReceipt := range []bool{false, true} {
		name := "new-device"
		if lostReceipt {
			name = "lost-commit-receipt"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			config := meta.Configuration
			config.DataDirectory = t.TempDir()
			store, e := NewStore(config.DataDirectory, config.Endpoint)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = store.Initialize(ctx, InitializationInput{SubjectType: "person"}, true, nil); e != nil {
				t.Fatal(e)
			}
			local, e := store.Identity(ctx)
			if e != nil {
				t.Fatal(e)
			}
			newRuntime := func() *Runtime {
				r, e := NewRuntime(store, config, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
				if e != nil {
					t.Fatal(e)
				}
				t.Cleanup(r.Close)
				return r
			}
			r := newRuntime()
			before := transport.count()
			plan, e := r.PrepareConnect(ctx)
			if e != nil || !plan.FirstUse || plan.GalaxyID != local["id"] || plan.DeviceID != "" {
				t.Fatal("first-use plan", plan, e)
			}
			if transport.count() != before {
				t.Fatal("preparing connection made remote writes")
			}
			scope, e := store.ChoiceScope(ctx)
			if e != nil {
				t.Fatal(e)
			}
			commits := 0
			transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
				if request.URL.Path == "/v2/identity/control/commit" {
					commits++
					if lostReceipt && commits == 1 {
						response.Body.Close()
						return nil, errors.New("lost receipt after commit")
					}
				}
				return response, nil
			})
			defer transport.setHook(nil)
			snapshot, e := r.ConnectReviewed(ctx, plan, &scope)
			if lostReceipt {
				if e == nil {
					t.Fatal("lost receipt claimed success")
				}
				r.Close()
				r = newRuntime()
				plan, e = r.PrepareConnect(ctx)
				if e != nil {
					t.Fatal(e)
				}
				snapshot, e = r.ConnectReviewed(ctx, plan, &scope)
			}
			if e != nil || snapshot == nil || snapshot.SubjectID != local["id"] || snapshot.BindingID == "" {
				t.Fatal("first real connection", snapshot, e)
			}
			if commits != 1 {
				t.Fatalf("bootstrap sent %d commits", commits)
			}
			plan, e = r.PrepareConnect(ctx)
			if e != nil || plan.FirstUse || plan.DeviceID == "" {
				t.Fatal("connection did not become a normal selected device", plan, e)
			}
			identityAfter, e := store.Identity(ctx)
			if e != nil || !connectionEqual(local, identityAfter) {
				t.Fatal("connection replaced local identity", e)
			}
		})
	}
}
