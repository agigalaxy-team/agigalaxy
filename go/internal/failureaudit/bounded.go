package failureaudit

import (
	"context"
	"sync"
	"time"
)

type Bounds struct {
	Timeout    time.Duration
	MaxPending int
}
type Bounded struct {
	mu      sync.Mutex
	pending int
	write   Writer
	bounds  Bounds
}

func NewBounded(write Writer, bounds Bounds) (*Bounded, error) {
	if bounds.Timeout == 0 {
		bounds.Timeout = 2 * time.Second
	}
	if bounds.MaxPending == 0 {
		bounds.MaxPending = 8
	}
	if write == nil || bounds.Timeout < time.Millisecond || bounds.Timeout > 10*time.Second || bounds.MaxPending < 1 || bounds.MaxPending > 32 {
		return nil, safeError("failure_audit_bounds_invalid")
	}
	return &Bounded{write: write, bounds: bounds}, nil
}

// A timeout is an unknown result, not permission to resubmit. In-flight slots
// remain occupied until the underlying write settles, even after cancellation.
func (b *Bounded) Record(ctx context.Context, event Event) string {
	var err error
	event, err = normalize(event, time.Now())
	if err != nil {
		return "failed"
	}
	b.mu.Lock()
	if b.pending >= b.bounds.MaxPending {
		b.mu.Unlock()
		return "capacity"
	}
	b.pending++
	b.mu.Unlock()
	done := make(chan string, 1)
	go func() {
		out := "failed"
		defer func() { _ = recover(); b.mu.Lock(); b.pending--; b.mu.Unlock(); done <- out }()
		result, e := b.write(context.Background(), event)
		if e == nil {
			out = "recorded"
			if result.State == "suppressed-by-deletion" {
				out = result.State
			}
		}
	}()
	timer := time.NewTimer(b.bounds.Timeout)
	defer timer.Stop()
	select {
	case out := <-done:
		return out
	case <-timer.C:
		return "unconfirmed"
	case <-ctx.Done():
		return "unconfirmed"
	}
}
