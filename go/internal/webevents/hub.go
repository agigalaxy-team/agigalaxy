package webevents

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5/pgxpool"
	"sync"
	"time"
)

type hub struct {
	pool        *pgxpool.Pool
	promotion   sync.Mutex
	mu          sync.Mutex
	subscribers map[uint64]chan struct{}
	next        uint64
	cancel      context.CancelFunc
	done, ready chan struct{}
}

func sharedHub(pool *pgxpool.Pool) *hub {
	v, _ := hubs.LoadOrStore(pool, &hub{pool: pool, subscribers: map[uint64]chan struct{}{}})
	return v.(*hub)
}
func (h *hub) wake() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.subscribers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
func (h *hub) drain(ctx context.Context) error {
	h.promotion.Lock()
	defer h.promotion.Unlock()
	for {
		var count int
		if e := h.pool.QueryRow(ctx, "SELECT galaxy_web_events_promote_v1($1)", maximumReplay).Scan(&count); e != nil {
			return e
		}
		if count > 0 {
			h.wake()
		}
		if count < maximumReplay {
			return nil
		}
		if e := ctx.Err(); e != nil {
			return e
		}
	}
}

// Subscribe waits until LISTEN is active before returning to the snapshot read.
// One connection per pool is retained until Stop, independently of browser count.
func (s *Service) Subscribe(ctx context.Context) (<-chan struct{}, func(), error) {
	h := sharedHub(s.Pool)
	h.mu.Lock()
	h.next++
	id := h.next
	ch := make(chan struct{}, 1)
	h.subscribers[id] = ch
	if h.cancel == nil {
		run, cancel := context.WithCancel(context.Background())
		h.cancel = cancel
		h.done = make(chan struct{})
		h.ready = make(chan struct{})
		go h.run(run, h.done, h.ready)
	}
	ready := h.ready
	h.mu.Unlock()
	var once sync.Once
	unsubscribe := func() { once.Do(func() { h.mu.Lock(); delete(h.subscribers, id); h.mu.Unlock() }) }
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	select {
	case <-ready:
		return ch, unsubscribe, nil
	case <-ctx.Done():
		unsubscribe()
		return nil, nil, ctx.Err()
	case <-timer.C:
		unsubscribe()
		return nil, nil, fault.New("web_events_listener_unavailable", 503)
	}
}
func (h *hub) run(ctx context.Context, done, ready chan struct{}) {
	defer close(done)
	announced := false
	for ctx.Err() == nil {
		conn, e := h.pool.Acquire(ctx)
		if e == nil {
			_, e = conn.Exec(ctx, "LISTEN galaxy_web_event_pending_v1; LISTEN galaxy_web_event_ready_v1")
			if e == nil {
				if !announced {
					close(ready)
					announced = true
				}
				e = h.drain(ctx)
				h.wake()
			}
			for e == nil && ctx.Err() == nil {
				wait, cancel := context.WithTimeout(ctx, 60*time.Second)
				n, err := conn.Conn().WaitForNotification(wait)
				expired := wait.Err() == context.DeadlineExceeded
				cancel()
				if err != nil {
					if ctx.Err() != nil {
						break
					}
					if expired {
						e = h.drain(ctx)
						continue
					}
					e = err
					break
				}
				if n.Channel == "galaxy_web_event_pending_v1" {
					e = h.drain(ctx)
				}
				if n.Channel == "galaxy_web_event_ready_v1" {
					h.wake()
				}
			}
			// LISTEN-mode connections never return to the general pool.
			closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			conn.Hijack().Close(closeCtx)
			cancel()
		}
		if ctx.Err() != nil {
			return
		}
		h.wake()
		timer := time.NewTimer(1500 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

// Stop must run before closing the database pool at process shutdown.
func (s *Service) Stop() {
	h := sharedHub(s.Pool)
	h.mu.Lock()
	cancel, done := h.cancel, h.done
	if cancel != nil {
		cancel()
	}
	h.mu.Unlock()
	if done != nil {
		<-done
	}
	hubs.Delete(s.Pool)
}
