package agentos

import (
	"context"
	"errors"
	"testing"
)

func TestConversationTextBarriersAndStoppedObserverJoin(t *testing.T) {
	ctx := context.Background()
	events := []Object{{"kind": "text", "text": "a", "eventIndex": 0}, {"kind": "text", "text": "b", "eventIndex": 1}, {"kind": "tool", "eventIndex": 2}, {"kind": "text", "text": "c", "eventIndex": 3}, {"kind": "terminal", "eventIndex": 4}}
	var got []Object
	err := coalesceConversationEvents(ctx, func(ctx context.Context, emit func(Object) error) error {
		for _, event := range events {
			if err := emit(event); err != nil {
				return err
			}
		}
		return nil
	}, func(event Object) error { got = append(got, event); return nil })
	if err != nil || len(got) != 4 || got[0]["text"] != "ab" || got[0]["eventIndex"] != 1 || got[1]["kind"] != "tool" || got[2]["text"] != "c" || got[3]["kind"] != "terminal" {
		t.Fatal("stream order or barrier lost", got, err)
	}
	done := make(chan struct{})
	count := 0
	err = coalesceConversationEvents(ctx, func(ctx context.Context, emit func(Object) error) error {
		defer close(done)
		for {
			if err := emit(Object{"kind": "tool"}); err != nil {
				return err
			}
		}
	}, func(Object) error { count++; return conversationLeaseEnded })
	if !errors.Is(err, conversationLeaseEnded) || count != 1 {
		t.Fatal("observer continued after stop", count, err)
	}
	select {
	case <-done:
	default:
		t.Fatal("stopped observer retained a source reader")
	}
}
