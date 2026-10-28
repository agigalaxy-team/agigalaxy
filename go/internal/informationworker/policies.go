package informationworker

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5/pgxpool"
)

// This process consumes policies for background source reads and watch receipts.
// It is a worker adoption instance, not an API editing/readiness instance. The
// API-role source pool owns these reads/receipts; River never uses this pool.
func startSourcePolicies(ctx context.Context, pool *pgxpool.Pool, c SourceConfiguration, budget *resourcebudget.Service, forum *community.Service, writes *publicwrites.Service, logger *slog.Logger) (*operationsrules.Lifecycle, error) {
	adoptForum, e := forum.PolicyAdopter()
	if e != nil {
		return nil, e
	}
	adoptWrites, e := writes.PolicyAdopter()
	if e != nil {
		return nil, e
	}
	current := budget.SnapshotPolicy()
	if current == nil {
		defaults := resourcebudget.DefaultPolicy()
		current = &defaults
	}
	raw, e := json.Marshal(current)
	if e != nil {
		return nil, e
	}
	var baseline operationsrules.Object
	if e = json.Unmarshal(raw, &baseline); e != nil {
		return nil, e
	}
	forumPolicy, _ := forum.PolicySnapshot()
	return operationsrules.Start(ctx, operationsrules.StartOptions{
		Rules: &operationsrules.Service{Pool: pool, Endpoint: c.Endpoint, Now: c.Now}, Component: "worker",
		Baselines: map[string]operationsrules.Object{"resource-budget": baseline, "forum-quota": forumPolicy, "community-quota": writes.Policy},
		Consumers: []operationsrules.PolicyConsumer{
			{Key: "resource-budget", Apply: func(ctx context.Context, p operationsrules.Object, _ int64) error {
				parsed, e := resourcebudget.ParsePolicy(p)
				if e != nil {
					return e
				}
				return budget.AdoptPolicy(parsed)
			}},
			{Key: "forum-quota", Apply: func(ctx context.Context, p operationsrules.Object, _ int64) error { return adoptForum(p) }},
			{Key: "community-quota", Apply: func(ctx context.Context, p operationsrules.Object, _ int64) error { return adoptWrites(p) }},
		},
		OnRefreshFailure: func(e error) {
			logger.Warn("operations_policy_refresh_failed", "process", "information-worker", "code", fault.Code(e))
		},
	})
}
