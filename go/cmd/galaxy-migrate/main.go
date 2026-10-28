// Explicit administrative technical migrations only. Worker and API startup
// never call this command. Schema work does not activate River or import jobs;
// selected old jobs require the separate explicit jobs-adopt action.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jobs"
	"github.com/agigalaxy-team/agigalaxy/go/internal/objectremoval"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimeconfig"
	"github.com/jackc/pgx/v5"
)

func run(ctx context.Context, args []string) error {
	if _, err := runtimeconfig.RuntimeServiceRelease(os.Getenv, "migration", ""); err != nil {
		return err
	}
	if len(args) > 0 && args[0] == "business-up" {
		return businessSchema(ctx, args[1:])
	}
	if len(args) > 0 && args[0] == "jobs-adopt" {
		return adoptJobs(ctx, args[1:])
	}
	if len(args) > 0 && args[0] == "jobs-adopt-schedule" {
		return adoptSchedule(ctx, args[1:])
	}
	if len(args) != 1 || (args[0] != "jobs-up" && args[0] != "jobs-provision-roles" && args[0] != "storage-up" && args[0] != "storage-provision-roles") {
		return fault.New("migration_action_required", 400)
	}
	if os.Getenv("DATABASE_URL") == "" {
		return fault.New("migration_configuration_invalid", 400)
	}
	pool, e := postgres.Open(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		return fault.New("database_unavailable", 503)
	}
	defer pool.Close()
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (bool, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('galaxy-go-jobs-migration',734912422))"); e != nil {
			return false, e
		}
		var e error
		switch args[0] {
		case "jobs-up":
			e = jobs.MigrateWithin(ctx, pool, tx)
		case "jobs-provision-roles":
			e = jobs.ProvisionRolesWithin(ctx, tx)
		case "storage-up":
			e = objectremoval.MigrateWithin(ctx, tx)
		case "storage-provision-roles":
			e = objectremoval.ProvisionRolesWithin(ctx, tx)
		}
		return e == nil, e
	})
	return e
}
func main() {
	if len(os.Args) == 2 && (os.Args[1] == "--help" || os.Args[1] == "-h") {
		fmt.Println("Usage: galaxy-migrate business-up [--roles=api,worker,deletion-review,content-publisher] | jobs-up | jobs-provision-roles | storage-up | storage-provision-roles\n       galaxy-migrate jobs-adopt --endpoint URL --ids-file ABS_JSON\n       galaxy-migrate jobs-adopt-schedule --endpoint URL --key messaging:PLAN_UUID\nRequires a separately supplied administrative DATABASE_URL. Business-up retains the original schema history; roles are opt-in. Technical role provisioning expects existing Galaxy roles. Schema actions never activate River or delete stored objects. Jobs-adopt hands over selected original unclaimed jobs; jobs-adopt-schedule hands over one original recurring definition using its actual slots. Stop old producers and consumers first; neither action enables River.")
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if e := run(ctx, os.Args[1:]); e != nil {
		slog.Error("Go technical migration failed", "code", fault.Code(e))
		os.Exit(1)
	}
	slog.Info("Go technical migration committed", "action", os.Args[1])
}

func businessSchema(ctx context.Context, args []string) error {
	if len(args) > 1 || len(args) == 1 && !strings.HasPrefix(args[0], "--roles=") {
		return fault.New("migration_action_required", 400)
	}
	roles := []string{}
	if len(args) == 1 {
		roles = strings.Split(strings.TrimPrefix(args[0], "--roles="), ",")
	}
	if _, err := databaseschema.ValidateMigrationRoles(roles); err != nil {
		return err
	}
	if os.Getenv("DATABASE_URL") == "" {
		return fault.New("migration_configuration_invalid", 400)
	}
	pool, err := postgres.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return fault.New("database_unavailable", 503)
	}
	defer pool.Close()
	version, err := databaseschema.Migrate(ctx, pool, roles)
	if err == nil {
		slog.Info("Go business schema migrated", "version", version, "roles", len(roles))
	}
	return err
}
