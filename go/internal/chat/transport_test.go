package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestComponentReconnectKeepsUnknownOperationAndStops(t *testing.T) {
	f := fakeArchive(t)
	transport, e := NewComponentTransport("xmpp://"+f.listener.Addr().String(), "gateway.example.invalid", "rooms.example.invalid", testSecret, 2*time.Second)
	if e != nil {
		t.Fatal(e)
	}
	ctx := context.Background()
	if e = transport.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer transport.Stop()
	probe, e := transport.Probe(ctx)
	if e != nil || !truth(probe, "authenticatedGateway") || truth(probe, "bodyReturned") {
		t.Fatalf("probe: %v %v", probe, e)
	}
	f.mu.Lock()
	f.probeBody = `<query xmlns='http://jabber.org/protocol/disco#info'><identity category='conference' type='text'/><feature var='http://jabber.org/protocol/muc'/><item jid='room-private'/></query>`
	f.mu.Unlock()
	if _, e = transport.Probe(ctx); fault.Code(e) != "chat_transport_invalid_reply" {
		t.Fatalf("probe accepted room item: %v", e)
	}
	f.mu.Lock()
	f.probeBody = ""
	f.mu.Unlock()
	id := uuid.NewString()
	f.mu.Lock()
	f.loseNext = true
	f.mu.Unlock()
	result := make(chan error, 1)
	go func() {
		_, e := transport.Command(ctx, "send", Object{"messageId": id, "text": "原操作"})
		result <- e
	}()
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	sent := false
	for !sent {
		select {
		case <-deadline:
			t.Fatal("send not received")
		case <-ticker.C:
			f.mu.Lock()
			sent = len(f.sendIDs) == 1
			if sent {
				f.connections[0].Close()
			}
			f.mu.Unlock()
		}
	}
	select {
	case e = <-result:
		if fault.Code(e) != "chat_delivery_unknown" {
			t.Fatal(e)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("disconnect left pending call")
	}
	connected := false
	for !connected {
		select {
		case <-deadline:
			t.Fatal("component did not reconnect")
		case <-ticker.C:
			f.mu.Lock()
			connected = len(f.connections) >= 2
			commands := len(f.sendIDs)
			f.mu.Unlock()
			connected = connected && transport.Available()
			if commands != 1 {
				t.Fatal("reconnect replayed a command")
			}
		}
	}
	ack, e := transport.Command(ctx, "send", Object{"messageId": id, "text": "原操作"})
	if e != nil || str(ack, "archiveId") != id {
		t.Fatalf("reconcile: %v %v", ack, e)
	}
	f.mu.Lock()
	if len(f.bodies) != 1 {
		t.Fatal("reconcile created duplicate archive")
	}
	count := len(f.connections)
	f.mu.Unlock()
	transport.Stop()
	timer := time.NewTimer(1200 * time.Millisecond)
	defer timer.Stop()
	<-timer.C
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.connections) != count || transport.Available() {
		t.Fatal("Stop did not cancel reconnect")
	}
}
