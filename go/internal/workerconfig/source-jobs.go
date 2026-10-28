package workerconfig

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/discovery"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/jackc/pgx/v5/pgxpool"
)

func legacyIndexWorker(ctx context.Context, pool *pgxpool.Pool, c Config, devices *deviceauth.Service, evidenceService *evidence.Service) (*discovery.LegacyIndex, error) {
	if c.SearchIndexMode == "" {
		return nil, nil
	}
	index := &discovery.LegacyIndex{Pool: pool, Endpoint: c.Endpoint, Devices: devices, Evidence: evidenceService}
	if _, err := index.Configure(ctx, c.SearchIndexMode == "true", false); err != nil {
		return nil, err
	}
	if c.SearchIndexMode == "false" {
		return nil, nil
	}
	return index, nil
}

// These are the existing explicit probe jobs and public-source index jobs.
// A process tick neither creates probes nor enables an unconfigured index.
func (r *Runtime) sourceMaintenance(ctx context.Context) {
	if ctx.Err() != nil || r.configuration.CanScan == nil {
		return
	}
	allowed, err := r.configuration.CanScan(ctx)
	if err != nil {
		maintenanceFailure(r.configuration, "source-job-eligibility", err)
		return
	}
	if !allowed {
		return
	}
	var adopted bool
	if err = r.Pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM galaxy_go_jobs.control_v1 WHERE endpoint=$1 AND backend='river')", r.configuration.Endpoint).Scan(&adopted); err != nil {
		maintenanceFailure(r.configuration, "source-job-adoption", err)
		return
	}
	if !adopted {
		return
	}
	if r.Probes != nil {
		if _, err = r.Probes.ProcessNext(ctx); err != nil {
			maintenanceFailure(r.configuration, "builder-probe", err)
		}
	}
	if r.LegacyIndex == nil || ctx.Err() != nil {
		return
	}
	stages := []struct {
		name string
		run  func(context.Context) (discovery.Object, error)
	}{
		{"search-seed", func(ctx context.Context) (discovery.Object, error) { return r.LegacyIndex.SeedBatch(ctx, 100) }},
		{"search-refresh", r.LegacyIndex.RefreshExpired},
		{"search-recovery", func(ctx context.Context) (discovery.Object, error) { return r.LegacyIndex.RecoverFailed(ctx, 100) }},
		{"search-process", func(ctx context.Context) (discovery.Object, error) {
			return r.LegacyIndex.ProcessNext(ctx, discovery.LegacyProcessOptions{})
		}},
	}
	for _, stage := range stages {
		if ctx.Err() != nil {
			return
		}
		if _, err = stage.run(ctx); err != nil {
			maintenanceFailure(r.configuration, stage.name, err)
			return
		}
	}
}
