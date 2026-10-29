package subjectlifecycle

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"sort"
	"strings"
	"testing"
)

// loadSyntheticExecution captures only original synthetic wire rows, not services
// or credentials. Signatures remain the original public evidence for replay.
func loadSyntheticExecution(t *testing.T, pool *pgxpool.Pool, path string) {
	t.Helper()
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, pool, []string{"api", "worker", "deletion-review"}); e != nil {
		t.Fatal(e)
	}
	fixture, e := os.ReadFile("testdata/synthetic-execution.json")
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(path, fixture, 0600); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile("testdata/synthetic-execution-data.json")
	if e != nil {
		t.Fatal(e)
	}
	var tables map[string][]json.RawMessage
	if e = json.Unmarshal(raw, &tables); e != nil {
		t.Fatal(e)
	}
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SET LOCAL session_replication_role=replica"); e != nil {
		t.Fatal(e)
	}
	names := make([]string, 0, len(tables))
	for name := range tables {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		rows, e := tx.Query(ctx, `SELECT attname FROM pg_attribute WHERE attrelid=to_regclass($1) AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`, "public."+name)
		if e != nil {
			t.Fatal(e)
		}
		cols, e := pgx.CollectRows(rows, pgx.RowTo[string])
		if e != nil || len(cols) == 0 {
			t.Fatalf("fixture columns %s: %v", name, e)
		}
		quoted := make([]string, len(cols))
		for i, col := range cols {
			quoted[i] = pgx.Identifier{col}.Sanitize()
		}
		table := pgx.Identifier{"public", name}.Sanitize()
		sql := "INSERT INTO " + table + "(" + strings.Join(quoted, ",") + ") OVERRIDING SYSTEM VALUE SELECT " + strings.Join(quoted, ",") + " FROM jsonb_populate_record(NULL::" + table + ",$1::jsonb) ON CONFLICT DO NOTHING"
		for _, row := range tables[name] {
			if _, e = tx.Exec(ctx, sql, []byte(row)); e != nil {
				t.Fatalf("fixture table %s: %v", name, e)
			}
		}
	}
	if _, e = tx.Exec(ctx, `SELECT setval(pg_get_serial_sequence('web_event_outbox_v1','id'),greatest(coalesce((SELECT max(id) FROM web_event_outbox_v1),0),1))`); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
}
