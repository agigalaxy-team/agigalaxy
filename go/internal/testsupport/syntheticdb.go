package testsupport

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

var fixtureTableName = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// RestoreSyntheticRows loads an explicit ordered set of captured synthetic
// records into a fresh isolated PostgreSQL fixture after Go migrations.
// Generated identities are assigned by PostgreSQL; no input selects a table.
func RestoreSyntheticRows(t *testing.T, pool *pgxpool.Pool, rows map[string]json.RawMessage, tables ...string) {
	t.Helper()
	ctx := context.Background()
	for _, table := range tables {
		if !fixtureTableName.MatchString(table) {
			t.Fatalf("invalid fixture table %q", table)
		}
		raw, ok := rows[table]
		if !ok {
			t.Fatalf("missing synthetic fixture table %s", table)
		}
		var columns string
		err := pool.QueryRow(ctx, `SELECT string_agg(quote_ident(attname), ',' ORDER BY attnum) FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' AND attidentity=''`, "public."+table).Scan(&columns)
		if err != nil {
			t.Fatalf("fixture columns %s: %v", table, err)
		}
		query := fmt.Sprintf("INSERT INTO public.%s (%s) SELECT %s FROM jsonb_populate_recordset(NULL::public.%s, $1::jsonb)", table, columns, columns, table)
		if _, err = pool.Exec(ctx, query, string(raw)); err != nil {
			t.Fatalf("fixture table %s: %v", table, err)
		}
	}
}
