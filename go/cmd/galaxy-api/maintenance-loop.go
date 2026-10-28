package main

import (
	"context"
	"sync"
	"time"
)

// The API owns these existing serial checks. Closing cancels and joins the
// current check before the database pool is closed; missed ticks do not queue.
func startMaintenance(parent context.Context, interval time.Duration, run func(context.Context) error, report func(error)) func() {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for ctx.Err() == nil {
			if err := run(ctx); err != nil && ctx.Err() == nil && report != nil {
				report(err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	var once sync.Once
	return func() { once.Do(cancel); <-done }
}
