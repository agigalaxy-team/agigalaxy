package native

import (
	"context"
	"testing"
)

func TestHostNoticePendingClearsQueuedOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	runtime := &Runtime{}
	connection := &hostSessionConnection{runtime: runtime, lifecycle: ctx, cancel: cancel, notices: make(chan hostSessionNotice, 2), done: make(chan struct{})}
	connection.notices <- hostSessionNotice{}
	connection.notices <- hostSessionNotice{}
	runtime.hostNotices.Add(2)
	if got := runtime.PendingHostNotifications(); got != 2 {
		t.Fatalf("pending = %d", got)
	}
	cancel()
	go connection.process()
	<-connection.done
	if got := runtime.PendingHostNotifications(); got != 0 {
		t.Fatalf("after cancellation = %d", got)
	}
	if !connection.noticeClosed {
		t.Fatal("notice admission remained open")
	}
}
