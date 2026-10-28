package workerconfig

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimeconfig"
	"github.com/jackc/pgx/v5/pgxpool"
)

func captureEvidenceSources(s *runtimeconfig.LoadedSources) func(*retirementPolicy, *incidentPolicy) {
	return func(r *retirementPolicy, i *incidentPolicy) {
		raw, _ := json.Marshal(r)
		_ = json.Unmarshal(raw, &s.Retirement)
		raw, _ = json.Marshal(i)
		_ = json.Unmarshal(raw, &s.Incident)
	}
}
func recordWorkerConfiguration(ctx context.Context, pool *pgxpool.Pool, c Config) error {
	if c.RuntimeSources == nil {
		return nil
	}
	sources := *c.RuntimeSources
	raw, e := protocol.EncodeJS(c.BudgetPolicy)
	if e != nil {
		return e
	}
	budgetHash := identity.Digest(raw)
	forumHash, e := community.ForumPolicyHash(c.ForumPolicy)
	if e != nil {
		return e
	}
	mode := "unconfigured"
	if c.SearchIndexMode == "true" {
		mode = "enabled"
	} else if c.SearchIndexMode == "false" {
		mode = "disabled"
	}
	sources.Hashes.ResourceBudget, sources.Hashes.ForumPolicy = &budgetHash, &forumHash
	sources.SearchIndexMode = &mode
	_, e = runtimeconfig.RecordLoaded(ctx, pool, c.Endpoint, "worker", c.OperatorRef, sources, runtimeconfig.Options{})
	return e
}
func startWorkerPolicies(ctx context.Context, pool *pgxpool.Pool, c Config, adoptForum func(community.Object) error) (*operationsrules.Lifecycle, error) {
	if c.RuntimeSources == nil {
		return nil, nil
	}
	raw, e := protocol.Encode(c.BudgetPolicy)
	if e != nil {
		return nil, e
	}
	var budget operationsrules.Object
	if e = protocol.Decode(raw, &budget); e != nil {
		return nil, e
	}
	return operationsrules.Start(ctx, operationsrules.StartOptions{Rules: &operationsrules.Service{Pool: pool, Endpoint: c.Endpoint}, Component: "worker", Baselines: map[string]operationsrules.Object{"resource-budget": budget, "forum-quota": c.ForumPolicy}, Consumers: []operationsrules.PolicyConsumer{
		{Key: "resource-budget", Apply: func(ctx context.Context, p operationsrules.Object, version int64) error {
			policy, e := resourcebudget.ParsePolicy(p)
			if e != nil {
				return e
			}
			return c.BudgetManager.AdoptPolicy(policy)
		}},
		{Key: "forum-quota", Apply: func(ctx context.Context, p operationsrules.Object, version int64) error { return adoptForum(p) }},
	}, OnRefreshFailure: func(e error) { maintenanceFailure(c, "policy-refresh", e) }})
}
