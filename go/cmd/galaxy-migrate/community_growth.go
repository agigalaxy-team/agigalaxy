package main

import (
	"context"
	"log/slog"
	"os"

	"github.com/agigalaxy-team/agigalaxy/go/internal/communitygrowth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
)

func activateCommunityGrowth(ctx context.Context, args []string) error {
	if len(args) != 2 || args[0] != "--endpoint" || args[1] == "" {
		return fault.New("migration_action_required", 400)
	}
	database := os.Getenv("DATABASE_URL")
	if database == "" {
		return fault.New("migration_configuration_invalid", 400)
	}
	pool, err := postgres.Open(ctx, database)
	if err != nil {
		return fault.New("database_unavailable", 503)
	}
	defer pool.Close()
	service := &communitygrowth.Service{Pool: pool, Endpoint: args[1]}
	result, err := service.ActivateGrowthLedger(ctx)
	if err == nil {
		slog.Info("Community growth ledger active", "activatedAt", result["activatedAt"], "resolvedAwards", result["resolvedAwards"])
	}
	return err
}
