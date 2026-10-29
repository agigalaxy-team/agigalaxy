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
	transport, e := NewComponentTransport("xmpp://"+f.Listener.Addr().String(), "gateway.example.invalid", "rooms.example.invalid", testSecret, 2*time.Second)
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
	f.Mu.Lock()
	f.ProbeBody = `<query xmlns='http://jabber.org/protocol/disco#info'><identity category='conference' type='text'/><feature var='http://jabber.org/protocol/muc'/><item jid='room-private'/></query>`
	f.Mu.Unlock()
	if _, e = transport.Probe(ctx); fault.Code(e) != "chat_transport_invalid_reply" {
		t.Fatalf("probe accepted room item: %v", e)
	}
	f.Mu.Lock()
	f.ProbeBody = ""
	f.Mu.Unlock()
	id := uuid.NewString()
	f.Mu.Lock()
	f.LoseNext = true
	f.Mu.Unlock()
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
			f.Mu.Lock()
			sent = len(f.SendIDs) == 1
			if sent {
				f.Connections[0].Close()
			}
			f.Mu.Unlock()
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
			f.Mu.Lock()
			connected = len(f.Connections) >= 2
			commands := len(f.SendIDs)
			f.Mu.Unlock()
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
	f.Mu.Lock()
	if len(f.Bodies) != 1 {
		t.Fatal("reconcile created duplicate archive")
	}
	count := len(f.Connections)
	f.Mu.Unlock()
	transport.Stop()
	timer := time.NewTimer(1200 * time.Millisecond)
	defer timer.Stop()
	<-timer.C
	f.Mu.Lock()
	defer f.Mu.Unlock()
	if len(f.Connections) != count || transport.Available() {
		t.Fatal("Stop did not cancel reconnect")
	}
}
