// Package informationworker assembles the existing Watch consumer with an API
// source pool and a separate restricted River transport pool. It owns neither
// source business queries nor schema migration or scheduler adoption.
package informationworker

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Config struct {
	SourcePool, TransportPool *pgxpool.Pool
	Endpoint                  string
	// Watches and its complete source graph are constructed by the root factory
	// on SourcePool. This runtime never substitutes a partial source dispatcher.
	Watches *information.Watches
	Logger  *slog.Logger
	OnError func(error)
}
type Runtime struct {
	queue         *jobs.Queue
	watches       *information.Watches
	endpoint      string
	logger        *slog.Logger
	onError       func(error)
	mu            sync.Mutex
	reconcileGate chan struct{}
	stopped       atomic.Bool
	started       bool
	cancel        context.CancelFunc
	done          chan struct{}
}

type databaseIdentity struct {
	role, database, host string
	port                 int
}

func poolIdentity(ctx context.Context, pool *pgxpool.Pool) (databaseIdentity, error) {
	var id databaseIdentity
	e := pool.QueryRow(ctx, `SELECT current_user,current_database(),COALESCE(inet_server_addr()::text,''),COALESCE(inet_server_port(),0)`).Scan(&id.role, &id.database, &id.host, &id.port)
	return id, e
}

// New performs read-only connection/graph checks. It does not migrate, change
// role grants, adopt River, enqueue work, start a goroutine or claim that an old
// Node consumer has stopped. Both explicit protected connections are required.
func New(ctx context.Context, c Config) (*Runtime, error) {
	if c.SourcePool == nil || c.TransportPool == nil || c.SourcePool == c.TransportPool || c.Endpoint == "" || c.Watches == nil || c.Watches.Pool != c.SourcePool || c.Watches.Devices == nil || c.Watches.Devices.Pool != c.SourcePool || c.Watches.Devices.Endpoint != c.Endpoint || c.Watches.Information == nil || c.Watches.Information.Endpoint != c.Endpoint || c.Watches.Information.Search == nil || c.Watches.Information.Search.Pool != c.SourcePool {
		return nil, fault.New("information_worker_configuration_unavailable", 503)
	}
	source, e := poolIdentity(ctx, c.SourcePool)
	if e != nil {
		return nil, e
	}
	transport, e := poolIdentity(ctx, c.TransportPool)
	if e != nil {
		return nil, e
	}
	if source.role != "galaxy_api" || transport.role != "galaxy_evidence_worker" || source.database != transport.database || source.host != transport.host || source.port != transport.port {
		return nil, fault.New("information_worker_role_boundary_mismatch", 503)
	}
	logger := c.Logger
	if logger == nil {
		logger = slog.Default()
	}
	r := &Runtime{endpoint: c.Endpoint, logger: logger, onError: c.OnError, reconcileGate: make(chan struct{}, 1)}
	current := *c.Watches
	r.watches = &current
	q, e := jobs.NewWithQueues(c.TransportPool, r.execute, map[string]int{jobs.InformationWatch: 1}, logger)
	if e != nil {
		return nil, e
	}
	r.queue = q
	current.Tasks = r.EnqueueWithin
	current.HasOutstanding = r.HasOutstandingWithin
	return r, nil
}

// EnqueueWithin uses the caller's original API transaction: the Watch command
// and its exact business key commit or roll back together. The queue's pool is
// still the worker pool; only explicit Start can claim transport work there.
func (r *Runtime) EnqueueWithin(ctx context.Context, tx pgx.Tx, key string, payload map[string]any, at time.Time) error {
	return r.queue.EnqueueInformationWatchWithin(ctx, tx, r.endpoint, payload, key, at)
}
func (r *Runtime) HasOutstandingWithin(ctx context.Context, tx pgx.Tx, id string, revision, checkRevision int64) (bool, error) {
	return r.queue.HasInformationWatchOutstandingWithin(ctx, tx, r.endpoint, id, revision, checkRevision)
}
func (r *Runtime) execute(ctx context.Context, task jobs.Task) (jobs.Outcome, error) {
	if task.Endpoint != r.endpoint || task.Action != jobs.InformationWatch || task.Payload["watchId"] != task.SourceID {
		return jobs.Outcome{}, fault.New("operations_job_payload_invalid", 400)
	}
	result, e := r.watches.ProcessJob(ctx, task.Payload)
	return jobs.Outcome{Result: result}, e
}
func (r *Runtime) Reconcile(ctx context.Context) (map[string]any, error) {
	if r.stopped.Load() {
		return map[string]any{"queued": 0}, nil
	}
	select {
	case r.reconcileGate <- struct{}{}:
		defer func() { <-r.reconcileGate }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if r.stopped.Load() {
		return map[string]any{"queued": 0}, nil
	}
	return r.watches.Reconcile(ctx)
}

// Start is explicitly invoked by the independent process after configuration
// and scheduler cutover. It starts only the information-watch queue, runs the
// original startup reconciliation and keeps its original 15-second interval.
func (r *Runtime) Start(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.started {
		return nil
	}
	if e := ctx.Err(); e != nil {
		return e
	}
	if e := r.queue.Start(ctx); e != nil {
		return e
	}
	r.stopped.Store(false)
	if _, e := r.Reconcile(ctx); e != nil {
		stopCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		_ = r.queue.Stop(stopCtx)
		return e
	}
	loop, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	r.done = make(chan struct{})
	r.started = true
	go func() {
		defer close(r.done)
		timer := time.NewTicker(15 * time.Second)
		defer timer.Stop()
		for {
			select {
			case <-loop.Done():
				return
			case <-timer.C:
				if _, e := r.Reconcile(loop); e != nil && !errors.Is(e, context.Canceled) {
					if r.onError != nil {
						r.onError(e)
					} else {
						r.logger.Error("information_watch_schedule_unavailable", "code", fault.Code(e))
					}
				}
			}
		}
	}()
	return nil
}
func (r *Runtime) Stop(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.stopped.Store(true)
	if !r.started {
		return r.waitReconcile(ctx)
	}
	r.cancel()
	if e := r.queue.Stop(ctx); e != nil {
		return e
	}
	select {
	case <-r.done:
	case <-ctx.Done():
		return ctx.Err()
	}
	// Also await an explicit reconciliation already in progress, just as the
	// original worker waits its shared reconciling promise on shutdown.
	if e := r.waitReconcile(ctx); e != nil {
		return e
	}
	r.started = false
	return nil
}

func (r *Runtime) waitReconcile(ctx context.Context) error {
	select {
	case r.reconcileGate <- struct{}{}:
		<-r.reconcileGate
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
