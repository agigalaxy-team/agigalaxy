package workerconfig

import (
	"context"
	"log/slog"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Retention keeps running during a publication/evidence pause, as in the
// existing worker. Only scanning uses that pause; approved cleanup is separate.
func attachmentMaintenance(pool *pgxpool.Pool, c Config, stored *access.StoredOperatorAuthority) func(context.Context) {
	if c.Files == nil {
		return nil
	}
	rooms := &chat.Service{Pool: pool, Endpoint: c.Endpoint}
	roomFiles := &chat.AttachmentService{Chat: rooms, Store: c.Files.Store, Scanner: c.Files.Scanner, Policy: c.Files.Policy}
	forumFiles := &community.AttachmentService{Forum: &community.Service{Pool: pool, Endpoint: c.Endpoint}, Store: c.Files.Store, Scanner: c.Files.Scanner, Policy: c.Files.Policy}
	governance := &filegovernance.Service{Pool: pool, Endpoint: c.Endpoint, Chat: roomFiles.GovernanceAdapter(), Forum: forumFiles.GovernanceAdapter()}
	if stored != nil {
		governance.StoredAuthority = stored
	}
	return func(ctx context.Context) {
		stages := []struct {
			name string
			run  func(context.Context) (map[string]any, error)
		}{
			{"chat-attachment-cleanup", func(ctx context.Context) (map[string]any, error) { return roomFiles.PurgeExpired(ctx, 20) }},
			{"forum-attachment-cleanup", func(ctx context.Context) (map[string]any, error) { return forumFiles.PurgeExpired(ctx, 20) }},
		}
		for _, stage := range stages {
			if ctx.Err() != nil {
				return
			}
			if _, err := stage.run(ctx); err != nil {
				maintenanceFailure(c, stage.name, err)
			}
		}
		if ctx.Err() != nil {
			return
		}
		if stored != nil {
			if _, err := governance.ProcessApproved(ctx, 1); err != nil {
				maintenanceFailure(c, "approved-file-cleanup", err)
			}
		}
		if ctx.Err() != nil || c.CanScan == nil {
			return
		}
		allowed, err := c.CanScan(ctx)
		if err != nil {
			maintenanceFailure(c, "attachment-scan-eligibility", err)
			return
		}
		if !allowed {
			return
		}
		if _, err = roomFiles.ScanPending(ctx, 1); err != nil {
			maintenanceFailure(c, "chat-attachment-scan", err)
		}
		if ctx.Err() != nil {
			return
		}
		if _, err = forumFiles.ScanPending(ctx, 1); err != nil {
			maintenanceFailure(c, "forum-attachment-scan", err)
		}
	}
}

func maintenanceFailure(c Config, stage string, err error) {
	if c.Diagnostic != nil {
		c.Diagnostic(stage, "", fault.Code(err))
		return
	}
	slog.Warn("worker maintenance deferred", "stage", stage, "code", fault.Code(err))
}

func (r *Runtime) maintenance(ctx context.Context) {
	var adopted bool
	if err := r.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')", r.configuration.Endpoint).Scan(&adopted); err != nil {
		maintenanceFailure(r.configuration, "worker-adoption", err)
		return
	}
	if !adopted {
		return
	}
	r.autonomyMaintenance(ctx)
	r.registeredMaintenance(ctx)
	r.retentionMaintenance(ctx)
	if r.Scheduler != nil {
		if _, err := r.Scheduler.Tick(ctx, 100); err != nil {
			maintenanceFailure(r.configuration, "message-schedule", err)
		}
	}
	if ctx.Err() == nil && r.attachmentMaintenance != nil {
		r.attachmentMaintenance(ctx)
	}
}

func (r *Runtime) adoptScheduler(queue *jobs.Queue, c Config, stored *access.StoredOperatorAuthority) {
	if r.Messaging != nil {
		r.Scheduler = &jobs.ScheduleQueue{Pool: r.Pool, Queue: queue, Endpoint: c.Endpoint}
		r.Messaging.Scheduler = r.Scheduler
	}
	r.attachmentMaintenance = attachmentMaintenance(r.Pool, c, stored)
	r.configuration = c
}
