package jobs

import (
	"context"
	"embed"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

//go:embed migrations/*.sql
var migrations embed.FS

// MigrateWithin is an explicit administrative technical migration. Runtime
// construction and Start never call it. Shared migration registration is owned
// by the application's migration entry point.
func MigrateWithin(ctx context.Context, pool *pgxpool.Pool, tx pgx.Tx) error {
	sql, e := migrations.ReadFile("migrations/001_galaxy_jobs.sql")
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, string(sql)); e != nil {
		return e
	}
	for _, name := range []string{"003_schedules.sql", "004_singletons.sql", "005_search_recovery.sql"} {
		body, err := migrations.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, string(body)); err != nil {
			return err
		}
	}
	migrator, e := rivermigrate.New(riverpgxv5.New(pool), &rivermigrate.Config{Schema: Schema})
	if e != nil {
		return e
	}
	_, e = migrator.MigrateTx(ctx, tx, rivermigrate.DirectionUp, nil)
	return e
}
func ProvisionRolesWithin(ctx context.Context, tx pgx.Tx) error {
	sql, e := migrations.ReadFile("migrations/002_roles.sql")
	if e != nil {
		return e
	}
	_, e = tx.Exec(ctx, string(sql))
	return e
}
