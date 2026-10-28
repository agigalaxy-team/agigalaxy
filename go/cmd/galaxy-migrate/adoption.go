package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/workerconfig"
	"github.com/jackc/pgx/v5"
)

func adoptJobs(ctx context.Context, args []string) error {
	if len(args) != 4 {
		return fault.New("migration_action_required", 400)
	}
	values := map[string]string{}
	for i := 0; i < len(args); i += 2 {
		key := args[i]
		if key != "--endpoint" && key != "--ids-file" || values[key] != "" || args[i+1] == "" {
			return fault.New("migration_action_required", 400)
		}
		values[key] = args[i+1]
	}
	if values["--endpoint"] == "" || !filepath.IsAbs(values["--ids-file"]) || os.Getenv("DATABASE_URL") == "" {
		return fault.New("migration_configuration_invalid", 400)
	}
	raw, err := os.ReadFile(values["--ids-file"])
	if err != nil {
		return fault.New("migration_selection_unavailable", 400)
	}
	var ids []string
	if json.Unmarshal(raw, &ids) != nil || len(ids) == 0 || len(ids) > 100 {
		return fault.New("migration_selection_invalid", 400)
	}
	pool, err := postgres.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return fault.New("database_unavailable", 503)
	}
	defer pool.Close()
	queue, err := jobs.New(pool, nil)
	if err != nil {
		return err
	}
	_, err = postgres.InTx(ctx, pool, func(tx pgx.Tx) (map[string]any, error) {
		return queue.AdoptPendingWithin(ctx, tx, values["--endpoint"], ids, workerconfig.VerifyLegacyPendingSourceWithin)
	})
	if err == nil {
		slog.Info("Selected original jobs handed over", "selected", len(ids))
	}
	return err
}

func adoptSchedule(ctx context.Context, args []string) error {
	if len(args) != 4 {
		return fault.New("migration_action_required", 400)
	}
	values := map[string]string{}
	for i := 0; i < len(args); i += 2 {
		key := args[i]
		if key != "--endpoint" && key != "--key" || values[key] != "" || args[i+1] == "" {
			return fault.New("migration_action_required", 400)
		}
		values[key] = args[i+1]
	}
	if values["--endpoint"] == "" || values["--key"] == "" || os.Getenv("DATABASE_URL") == "" {
		return fault.New("migration_configuration_invalid", 400)
	}
	pool, err := postgres.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return fault.New("database_unavailable", 503)
	}
	defer pool.Close()
	queue, err := jobs.New(pool, nil)
	if err != nil {
		return err
	}
	schedules := &jobs.ScheduleQueue{Pool: pool, Queue: queue, Endpoint: values["--endpoint"]}
	_, err = postgres.InTx(ctx, pool, func(tx pgx.Tx) (map[string]any, error) {
		return schedules.AdoptLegacyRecurringWithin(ctx, tx, values["--key"], workerconfig.VerifyLegacyRecurringSourceWithin)
	})
	if err == nil {
		slog.Info("Selected original recurring definition handed over")
	}
	return err
}
