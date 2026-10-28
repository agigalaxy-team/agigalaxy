package workerconfig

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/agentos"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsai"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsautonomy"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsqueries"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Duty uses its durable AI identity. No browser session, administrator token,
// schema migration or implicit enabling is involved in worker construction.
func autonomyWorker(pool *pgxpool.Pool, c Config, stored *access.StoredOperatorAuthority, messages *messaging.Service) (*operationsautonomy.Worker, error) {
	client, err := agentos.New(c.AgentOS, agentos.Options{})
	if err != nil {
		return nil, err
	}
	ai := &operationsai.Service{Endpoint: c.Endpoint}
	permissions := &operationspermissions.Service{Pool: pool, Endpoint: c.Endpoint, StoredAuthority: stored, AIWork: ai}
	service := &operationsautonomy.Service{Pool: pool, Endpoint: c.Endpoint, AIWork: ai, Permissions: permissions, Native: &operationsautonomy.NativeClient{Client: client}, RuntimeStatus: func(ctx context.Context) (operationsautonomy.Object, error) { return client.Status(ctx), nil }}
	service.CodeRunner = service.RunWorkerCodeTask
	permissions.Duty = service
	service.QueryTool = (&operationsqueries.Service{Pool: pool, Permissions: permissions, Messaging: messages}).Query
	if messages != nil {
		service.PersistedSourceWithin = messages.PersistedSourceWithin
	}
	service.Log = func(value operationsautonomy.Object) {
		if code, ok := value["code"].(string); ok && c.Diagnostic != nil {
			c.Diagnostic("autonomy", "", code)
		}
	}
	return operationsautonomy.NewWorker(service), nil
}

func (r *Runtime) adoptAutonomy(queue *jobs.Queue) {
	r.Autonomy.Service.EnqueueWithin = func(ctx context.Context, tx pgx.Tx, kind string, payload operationsautonomy.Object, key string, start *time.Time) error {
		return queue.EnqueueAutonomyWithin(ctx, tx, r.configuration.Endpoint, kind, payload, key, start)
	}
}

func (r *Runtime) autonomyMaintenance(ctx context.Context) {
	if r.Autonomy == nil {
		return
	}
	// Read current configured cadence; this is health scheduling, not a model call.
	seconds := int64(30)
	tx, err := r.Pool.Begin(ctx)
	if err == nil {
		settings, e := r.Autonomy.Service.RuntimeSettingsWithin(ctx, tx)
		if e == nil {
			switch n := settings["healthSeconds"].(type) {
			case int64:
				seconds = n
			case float64:
				seconds = int64(n)
			case int:
				seconds = int64(n)
			}
		}
		_ = tx.Rollback(ctx)
		if e != nil {
			maintenanceFailure(r.configuration, "autonomy-settings", e)
			return
		}
	} else {
		maintenanceFailure(r.configuration, "autonomy-settings", err)
		return
	}
	if seconds < 10 || seconds > 300 {
		seconds = 30
	}
	at := time.Now()
	if !r.nextAutonomyHealth.IsZero() && at.Before(r.nextAutonomyHealth) {
		return
	}
	r.nextAutonomyHealth = at.Add(time.Duration(seconds) * time.Second)
	if _, err = r.Autonomy.Tick(ctx); err != nil {
		maintenanceFailure(r.configuration, "autonomy-health", err)
	}
}
