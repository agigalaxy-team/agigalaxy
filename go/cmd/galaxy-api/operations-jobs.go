package main

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/information"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsjobs"
	p "github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsretention"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publication"
	"github.com/jackc/pgx/v5"
)

func operationsJobService(gateway *access.Gateway, duty p.DutyAuthority, queue *jobs.Queue, search *discovery.LegacyIndex, watches *information.Watches, retention *operationsretention.Service, messages *messaging.Service, publications *publication.Commands) *operationsjobs.Service {
	return &operationsjobs.Service{Pool: gateway.Pool, Endpoint: gateway.Config.Endpoint, Authority: &p.BusinessAuthority{Human: gateway, Duty: duty}, Duty: duty, Queue: queue, Search: search, Watches: watches, Retention: retention,
		Cancellations: map[string]operationsjobs.Cancellation{
			jobs.ContentPublication: func(ctx context.Context, tx pgx.Tx, actor p.Actor, task jobs.Task) error { return publications.CancelJobWithin(ctx, tx, task.SourceID) },
			jobs.AccountNotice: func(ctx context.Context, tx pgx.Tx, actor p.Actor, task jobs.Task) error {
				return messages.CancelNoticeWithin(ctx, tx, actor, task.SourceID)
			},
		}}
}
