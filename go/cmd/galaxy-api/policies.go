package main

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"log/slog"
)

func startAPIPolicies(ctx context.Context, gateway *access.Gateway, budget *resourcebudget.Service, forum *community.Service, writes *publicwrites.Service, logger *slog.Logger) (*operationsrules.Lifecycle, error) {
	adoptForum, err := forum.PolicyAdopter()
	if err != nil {
		return nil, err
	}
	adoptWrites, err := writes.PolicyAdopter()
	if err != nil {
		return nil, err
	}
	currentBudget := budget.SnapshotPolicy()
	if currentBudget == nil {
		defaults := resourcebudget.DefaultPolicy()
		currentBudget = &defaults
	}
	raw, err := json.Marshal(currentBudget)
	if err != nil {
		return nil, err
	}
	var baselineBudget operationsrules.Object
	if err = json.Unmarshal(raw, &baselineBudget); err != nil {
		return nil, err
	}
	forumPolicy, _ := forum.PolicySnapshot()
	return operationsrules.Start(ctx, operationsrules.StartOptions{
		Rules: &operationsrules.Service{Pool: gateway.Pool, Endpoint: gateway.Config.Endpoint, Authority: gateway}, Component: "api",
		Baselines: map[string]operationsrules.Object{"resource-budget": baselineBudget, "forum-quota": forumPolicy, "community-quota": writes.Policy},
		Consumers: []operationsrules.PolicyConsumer{
			{Key: "resource-budget", Apply: func(ctx context.Context, policy operationsrules.Object, version int64) error {
				parsed, err := resourcebudget.ParsePolicy(policy)
				if err != nil {
					return err
				}
				return budget.AdoptPolicy(parsed)
			}},
			{Key: "community-quota", Apply: func(ctx context.Context, policy operationsrules.Object, version int64) error {
				return adoptWrites(policy)
			}},
			{Key: "forum-quota", Apply: func(ctx context.Context, policy operationsrules.Object, version int64) error {
				return adoptForum(policy)
			}},
		},
		OnRefreshFailure: func(err error) { logger.Warn("operations_policy_refresh_failed", "code", fault.Code(err)) },
	})
}
