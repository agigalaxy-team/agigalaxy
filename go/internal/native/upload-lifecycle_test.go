package native

import (
	"context"
	"testing"
)

func TestPrivateSyncStopsForDisabledAndClosedLifecycle(t *testing.T) {
	store := materialStore(t)
	rt, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	if retry, active := rt.privateSync.run(context.Background()); retry || active {
		t.Fatal("disabled saved permission scheduled recovery")
	}
	rt.mu.Lock()
	rt.stopped = true
	rt.mu.Unlock()
	if retry, active := rt.privateSync.run(context.Background()); retry || active {
		t.Fatal("stopped connection scheduled recovery")
	}
	rt.Close()
	if retry, active := rt.privateSync.run(context.Background()); retry || active {
		t.Fatal("closed runtime scheduled recovery")
	}
}
