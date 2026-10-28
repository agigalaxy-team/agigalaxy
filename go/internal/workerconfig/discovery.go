package workerconfig

import (
	"context"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discoveryconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5/pgxpool"
)

func discoveryWorker(ctx context.Context, pool *pgxpool.Pool, c Config) (*discovery.Worker, error) {
	if c.Discovery == nil {
		return nil, nil
	}
	metadata := c.Discovery.SourceMetadata
	if metadata == nil {
		return nil, fault.New("discovery_worker_source_metadata_required", 503)
	}
	forum := c.Forum
	if forum == nil {
		forum = &community.Service{Pool: pool, Endpoint: c.Endpoint, Policy: c.ForumPolicy}
	}
	forum.ModeratorIDs = append([]string(nil), metadata.ModeratorIDs...)
	for _, provider := range metadata.IdentityProviders {
		forum.IdentityProviders = append(forum.IdentityProviders, community.IdentityProvider{Issuer: provider.Issuer, ClientID: provider.ClientID})
	}
	runtime, err := discoveryconfig.Runtime(pool, c.Endpoint, c.Discovery, forum, true, nil)
	if err != nil {
		return nil, err
	}
	// The worker initializes only its existing outbox cursor, never engine settings.
	if err = runtime.Store.Initialize(ctx); err != nil {
		return nil, err
	}
	return &discovery.Worker{Runtime: runtime}, nil
}

func (r *Runtime) discoveryMaintenance(ctx context.Context) {
	if r.Discovery == nil || r.configuration.CanScan == nil {
		return
	}
	allowed, err := r.configuration.CanScan(ctx)
	if err != nil {
		maintenanceFailure(r.configuration, "discovery-eligibility", err)
		return
	}
	if !allowed {
		return
	}
	var adopted bool
	if err = r.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')", r.configuration.Endpoint).Scan(&adopted); err != nil {
		maintenanceFailure(r.configuration, "discovery-adoption", err)
		return
	}
	if !adopted {
		return
	}
	if r.discoverySeedComplete && !time.Now().Before(r.nextDiscoveryReconcile) {
		r.discoverySeedComplete = false
	}
	if !r.discoverySeedComplete {
		result, e := r.Discovery.SeedBatch(ctx, 100)
		if e != nil {
			maintenanceFailure(r.configuration, "discovery-seed", e)
			return
		}
		r.discoverySeedComplete = result["complete"] == true
		if r.discoverySeedComplete {
			r.nextDiscoveryReconcile = time.Now().Add(time.Minute)
		}
	}
	if ctx.Err() != nil {
		return
	}
	if _, err = r.Discovery.IndexOne(ctx); err != nil {
		maintenanceFailure(r.configuration, "discovery-index", err)
	}
	if ctx.Err() != nil {
		return
	}
	if _, err = r.Discovery.DeliverOne(ctx); err != nil {
		maintenanceFailure(r.configuration, "discovery-delivery", err)
	}
}
