package main

import (
	"context"
	"sync"
	"time"
)

type probeFlight struct {
	done  chan struct{}
	ready bool
	once  sync.Once
}

func (f *probeFlight) finish(ready bool) {
	f.once.Do(func() { f.ready = ready; close(f.done) })
}

// A timed-out backend check remains the only check until it actually returns.
// This retains the original bound even if a dependency ignores cancellation.
func boundedReadiness(ctx context.Context, timeout time.Duration, probe func(context.Context) bool) func(context.Context) bool {
	var mu sync.Mutex
	var active *probeFlight
	return func(request context.Context) bool {
		mu.Lock()
		if active == nil {
			flight := &probeFlight{done: make(chan struct{})}
			active = flight
			check, cancel := context.WithTimeout(ctx, timeout)
			stop := context.AfterFunc(check, func() { flight.finish(false) })
			go func() {
				defer cancel()
				ready := probe(check)
				stop()
				flight.finish(ready && check.Err() == nil)
				mu.Lock()
				if active == flight {
					active = nil
				}
				mu.Unlock()
			}()
		}
		flight := active
		mu.Unlock()
		select {
		case <-request.Done():
			return false
		case <-flight.done:
			return flight.ready
		}
	}
}
