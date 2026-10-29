package discovery

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestSearchDraftDutyCreationScopePG(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	f := operationsfixture.New(t, owner)
	ctx := context.Background()
	eligible, selected, target := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, grant := range []struct {
		id, scope string
		ids       []string
	}{{eligible, "eligible", []string{}}, {selected, "selected", []string{target}}} {
		_, e := owner.Exec(ctx, `INSERT INTO operations_automation_grants_v1(id,endpoint,name,executor_kind,mode,enabled,version,permissions,resource_ids,created_by,updated_by,created_at,updated_at,resource_scope_kind) VALUES($1,$2,'Draft test','program','automatic',true,1,$3,$4,$5,$5,$6,$6,$7)`, grant.id, f.Endpoint, []string{"search-quality.configure"}, grant.ids, f.Root.ID, f.Now(), grant.scope)
		if e != nil {
			t.Fatal(e)
		}
	}
	q := &SearchQuality{Pool: f.Pool, Endpoint: f.Endpoint}
	command := Object{"expectedRevision": 0, "expectedDraftId": nil, "settings": Object{"synonyms": []any{}, "rankingMode": "relevance", "fixedConstraints": fixedConstraints}}
	check := func(grant string) error {
		_, e := postgres.InTx(ctx, f.Pool, func(tx pgx.Tx) (bool, error) {
			return true, q.QualifyPreparedDraftWithin(ctx, tx, f.Root, command, target, grant)
		})
		return e
	}
	if e := check(eligible); e != nil {
		t.Fatalf("eligible creation: %v", e)
	}
	if e := check(selected); e == nil {
		t.Fatal("selected grant authorized creation")
	}
	command["expectedRevision"] = 1
	if e := check(eligible); e == nil {
		t.Fatal("stale revision accepted")
	}
}
