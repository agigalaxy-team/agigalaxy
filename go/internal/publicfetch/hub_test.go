package publicfetch

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestHubPeeringClosedRouteAndPayloadBeforeIO(t *testing.T) {
	for _, target := range []string{"http://127.0.0.1/v2/hubs/peering/exchange", "https://127.0.0.1/v2/hubs/peering/exchange", "https://peer.example.org/v1/sessions", "https://peer.example.org/v2/hubs/peering/%65xchange", "https://peer.example.org/v2/hubs/peering/exchange?credential=x"} {
		if _, e := PostHubPeering(context.Background(), target, []byte(`{"signed":"synthetic"}`), 65536, 5*time.Second); e == nil {
			t.Fatal("unexpected peering destination")
		}
	}
	for _, body := range []string{`{}`, `{"signed":null}`, `{"signed":1}`, `{"signed":"x","credential":"no"}`, `{"signed":"` + strings.Repeat("x", 32768) + `"}`} {
		if _, e := PostHubPeering(context.Background(), "https://peer.example.org/v2/hubs/peering/exchange", []byte(body), 65536, 5*time.Second); e == nil {
			t.Fatal("unexpected peering payload")
		}
	}
}
