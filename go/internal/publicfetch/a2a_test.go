package publicfetch

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestA2AProbeGateRejectsWorkAndPrivateDestinationsBeforeIO(t *testing.T) {
	raw := `{"jsonrpc":"2.0","id":1,"method":"GetTask","params":{"id":"cc43f0ce-0a11-4ce4-b8b7-71287597ed3e","tenant":"fixture","historyLength":0}}`
	if !validA2ARead([]byte(raw)) {
		t.Fatal("original fresh GetTask rejected")
	}
	for _, bad := range []string{strings.Replace(raw, "GetTask", "SendMessage", 1), strings.Replace(raw, `"historyLength":0`, `"historyLength":1`, 1), strings.Replace(raw, `"tenant":"fixture"`, `"tenant":"fixture","credential":"no"`, 1), strings.Replace(raw, `"id":1`, `"id":1.5`, 1), strings.Replace(raw, `"id":"cc43f0ce-0a11-4ce4-b8b7-71287597ed3e"`, `"id":"known-private-task"`, 1)} {
		if validA2ARead([]byte(bad)) {
			t.Fatal("expanded public POST scope")
		}
		if _, e := PostA2A(context.Background(), "https://peer.example.org/a2a", []byte(bad), 65536, 5*time.Second); e == nil {
			t.Fatal("invalid request reached transport")
		}
	}
	for _, address := range []string{"http://127.0.0.1/a2a", "https://127.0.0.1/a2a", "https://10.1.2.3/a2a", "https://user:pass@example.org/a2a", "https://peer.example.org/a2a?token=x", "https://peer.local/a2a"} {
		if _, e := PostA2A(context.Background(), address, []byte(raw), 65536, 5*time.Second); e == nil {
			t.Fatal("unsafe public request allowed")
		}
	}
}
