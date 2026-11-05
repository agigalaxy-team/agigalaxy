package native

import (
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestPendingInteractionsCountsLiveChoicesAndPreviews(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Millisecond)
	future := now.Add(2 * time.Minute)
	past := now.Add(-time.Minute)
	clock := func() time.Time { return now }
	runtime := &Runtime{connection: &Connection{now: clock}}
	accounts := &NativeIdentityAccounts{runtime: runtime, previews: map[string]*nativeAccountPreview{
		"prepared":    {state: "prepared", expiresAt: future.UnixMilli()},
		"expired":     {state: "prepared", expiresAt: past.UnixMilli()},
		"running":     {state: "running", expiresAt: past.UnixMilli()},
		"recoverable": {state: "unknown", expiresAt: future.UnixMilli()},
	}}
	browser := NewBrowserChoices(nil, clock)
	browser.entries["account"] = &interactionBrowserEntry{state: "awaiting-account", expires: future}
	browser.entries["declined"] = &interactionBrowserEntry{state: "declined-delivered", expires: future}
	browser.recoveryEntries = map[string]*recoveryBrowserEntry{"open": {stage: "set-save", expires: future}, "done": {stage: "done", expires: future}}
	rt := &toolRuntime{browser: browser, choices: map[string]*choiceRecord{"result": {Expires: future, Result: &mcp.CallToolResult{}}, "expired": {Expires: past}}, pending: []func() (int, time.Time){accounts.pendingInteractions}}
	server := &ToolServer{tools: rt}
	count, expiry := server.PendingInteractions()
	if count != 4 || !expiry.Equal(future) {
		t.Fatalf("pending = %d, %v", count, expiry)
	}
	accounts.previews["prepared"].state = "completed"
	accounts.previews["running"].state = "unknown"
	browser.entries["account"].completed = true
	browser.recoveryEntries["open"].stage = "done"
	if count, expiry = server.PendingInteractions(); count != 0 || !expiry.IsZero() {
		t.Fatalf("finished = %d, %v", count, expiry)
	}
}

func TestPendingInteractionsKeepsRunningPastExpiryAndDoesNotWaitOnOwnerLock(t *testing.T) {
	now := time.Now()
	host := &NativeA2a{options: A2aOptions{Now: func() time.Time { return now }}, previews: map[string]*A2aPreview{"running": {state: "running", expires: now.Add(-time.Minute).UnixMilli()}}}
	count, expiry := host.pendingInteractions()
	if count != 1 || !expiry.IsZero() {
		t.Fatalf("running = %d, %v", count, expiry)
	}
	host.mu.Lock()
	count, expiry = host.pendingInteractions()
	host.mu.Unlock()
	if count != 1 || !expiry.IsZero() {
		t.Fatalf("busy = %d, %v", count, expiry)
	}
	var server *ToolServer
	if count, expiry = server.PendingInteractions(); count != 0 || !expiry.IsZero() {
		t.Fatalf("nil = %d, %v", count, expiry)
	}
}

func TestRecoveryPrunePreservesInFlightPage(t *testing.T) {
	now := time.Now()
	browser := NewBrowserChoices(nil, func() time.Time { return now })
	entry := &recoveryBrowserEntry{stage: "recover", expires: now.Add(-time.Second)}
	browser.recoveryEntries = map[string]*recoveryBrowserEntry{"page": entry}
	entry.mu.Lock()
	browser.pruneLocked()
	count, _ := browser.pendingInteractions()
	if browser.recoveryEntries["page"] == nil || count != 1 {
		entry.mu.Unlock()
		t.Fatal("in-flight expired recovery page was discarded")
	}
	entry.mu.Unlock()
	browser.pruneLocked()
	if browser.recoveryEntries["page"] != nil {
		t.Fatal("finished expired recovery page retained")
	}
}
