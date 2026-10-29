// Package databaseschema applies the existing official business schema history.
// Provisioning is explicit administrative work and is never run by services.
package databaseschema

import (
	"context"
	"embed"
	"errors"
	"strconv"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SQL is the authoritative, unchanged business migration history and the four
// role scripts. generate.mjs derives only the ordered catalog from these files.
//
//go:generate node generate.mjs
//go:embed sql/*.sql
var scripts embed.FS

var supportedRoles = [...]string{"api", "worker", "deletion-review", "content-publisher"}

func ValidateMigrationRoles(roles []string) ([]string, error) {
	seen := make(map[string]bool, len(roles))
	out := make([]string, 0, len(roles))
	for _, role := range roles {
		supported := false
		for _, candidate := range supportedRoles {
			if role == candidate {
				supported = true
				break
			}
		}
		if !supported || seen[role] {
			return nil, errors.New("Explicit supported migration roles required.")
		}
		seen[role] = true
		out = append(out, role)
	}
	return out, nil
}

// Versions returns the original ordered catalog, not a separate migration ledger.
func Versions() []int { return append([]int(nil), migrationVersions[:]...) }

// Migrate uses one connection, transaction and the original advisory lock for
// schema and optional roles. Any provisioning failure rolls back all changes.
func Migrate(ctx context.Context, pool *pgxpool.Pool, roles []string) (int, error) {
	selected, err := ValidateMigrationRoles(roles)
	if err != nil {
		return 0, err
	}
	roleSQL := make([]string, 0, len(selected))
	for _, role := range selected {
		data, e := scripts.ReadFile("sql/" + role + "-role.sql")
		if e != nil {
			return 0, e
		}
		roleSQL = append(roleSQL, string(data))
	}
	return postgres.InTx(ctx, pool, func(tx pgx.Tx) (int, error) {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(734912306)`); e != nil {
			return 0, e
		}
		if _, e := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`); e != nil {
			return 0, e
		}
		rows, e := tx.Query(ctx, `SELECT version FROM schema_migrations ORDER BY version`)
		if e != nil {
			return 0, e
		}
		applied, e := pgx.CollectRows(rows, pgx.RowTo[int])
		if e != nil {
			return 0, e
		}
		known := make(map[int]bool, len(migrationVersions))
		for _, v := range migrationVersions {
			known[v] = true
		}
		for _, v := range applied {
			if !known[v] {
				return 0, errors.New("Database schema is newer than this application.")
			}
		}
		for i, v := range applied {
			if v != migrationVersions[i] {
				return 0, errors.New("Migration history must be a contiguous prefix; repair requires explicit review.")
			}
		}
		for _, version := range migrationVersions[len(applied):] {
			sql, e := scripts.ReadFile("sql/" + strconv.Itoa(version) + ".sql")
			if e != nil {
				return 0, e
			}
			// No parameters: pgx uses the simple query protocol, preserving the original
			// assembled multi-statement SQL on this transaction's connection.
			if _, e = tx.Exec(ctx, string(sql)); e != nil {
				return 0, e
			}
			if _, e = tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, version); e != nil {
				return 0, e
			}
		}
		for _, sql := range roleSQL {
			if _, e = tx.Exec(ctx, sql); e != nil {
				return 0, e
			}
		}
		return migrationVersions[len(migrationVersions)-1], nil
	})
}
