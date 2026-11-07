package communitygrowth

import (
	"context"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestExperienceLedgerCarriesOriginalAward(t *testing.T) {
	ctx := context.Background()
	pool, _ := testsupport.PostgreSQL(t)
	if _, err := databaseschema.Migrate(ctx, pool, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	prepared := time.Unix(2000000000, 0).UTC()
	now := prepared
	endpoint := "https://growth-ledger.example.invalid"
	forum := &community.Service{Pool: pool, Endpoint: endpoint}
	s := &Service{Pool: pool, Endpoint: endpoint, Forum: forum, Now: func() time.Time { return now }}
	profiles := &accounts.Service{Endpoint: endpoint, Now: s.Now}
	account, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (accounts.Account, error) {
		return profiles.EnsureAccountWithin(ctx, tx, accounts.VerifiedIdentity{
			Issuer: "https://login.example.invalid", ExternalSubject: uuid.NewString(),
			VerificationMethod: "external-account", VerifiedAt: prepared,
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	inTx := func(f func(pgx.Tx) error) {
		t.Helper()
		if _, err := postgres.InTx(ctx, pool, func(tx pgx.Tx) (struct{}, error) { return struct{}{}, f(tx) }); err != nil {
			t.Fatal(err)
		}
	}
	source := func(id string, at time.Time) Source {
		return Source{Kind: "activity", ID: id, RuleKey: "activity", AccountID: account.ID, Domains: []string{"technology"}, Active: true, Revision: 1, OccurredAt: at}
	}
	record := func(x Source) { inTx(func(tx pgx.Tx) error { return s.RecordSourceWithin(ctx, tx, x) }) }
	value := func(id string, expected int64, basis string, active bool) {
		t.Helper()
		var amount int64
		var storedBasis string
		var storedActive bool
		err := pool.QueryRow(ctx, `SELECT growth_experience,growth_basis,active FROM community_growth_sources_v1
			WHERE endpoint=$1 AND source_id=$2`, endpoint, id).Scan(&amount, &storedBasis, &storedActive)
		if err != nil || amount != expected || storedBasis != basis || storedActive != active {
			t.Fatalf("%s: amount=%d basis=%q active=%v error=%v", id, amount, storedBasis, storedActive, err)
		}
	}
	legacy := source("legacy", prepared.Add(-time.Hour))
	record(legacy)
	if _, err = pool.Exec(ctx, `UPDATE community_growth_sources_v1 SET growth_basis='legacy' WHERE endpoint=$1 AND source_id=$2`, endpoint, legacy.ID); err != nil {
		t.Fatal(err)
	}
	newer := source("newer", prepared.Add(time.Minute))
	now = newer.OccurredAt
	record(newer)
	now = prepared.Add(2 * time.Minute)
	inTx(func(tx pgx.Tx) error {
		_, err := s.saveRule(ctx, tx, Object{"ruleKey": "activity", "label": "活动成果", "enabled": true, "experience": 14, "expectedVersion": 1})
		return err
	})
	now = prepared.Add(3 * time.Minute)
	record(source("late", newer.OccurredAt))
	record(source("current", now))
	record(source("historical", legacy.OccurredAt))
	w := Worker{Service: s, Forum: forum}
	for i := 0; i < 2; i++ {
		if _, err = w.Step(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = s.ActivateGrowthLedger(ctx); err != nil {
		t.Fatal(err)
	}
	value("legacy", 14, "legacy", true)
	value("historical", 14, "baseline", true)
	value("newer", 10, "version", true)
	value("late", 10, "version", true)
	value("current", 14, "version", true)
	newer.Active, newer.Revision = false, 2
	record(newer)
	value("newer", 10, "version", false)
	record(source("newer", newer.OccurredAt))
	value("newer", 10, "version", false)
	newer.Active, newer.Revision = true, 3
	newer.Domains = []string{"technology", "science"}
	record(newer)
	value("newer", 10, "version", true)

	publishing, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer publishing.Rollback(ctx)
	now = prepared.Add(4 * time.Minute)
	if _, err = s.saveRule(ctx, publishing, Object{"ruleKey": "activity", "label": "活动成果", "enabled": true, "experience": 18, "expectedVersion": 2}); err != nil {
		t.Fatal(err)
	}
	now = prepared.Add(5 * time.Minute)
	record(source("concurrent", now))
	var unresolved bool
	if err = pool.QueryRow(ctx, `SELECT growth_rule_version IS NULL FROM community_growth_sources_v1 WHERE endpoint=$1 AND source_id='concurrent'`, endpoint).Scan(&unresolved); err != nil || !unresolved {
		t.Fatalf("source should commit while the rule is still publishing: unresolved=%v error=%v", unresolved, err)
	}
	if err = publishing.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = w.Step(ctx); err != nil {
		t.Fatal(err)
	}
	value("concurrent", 18, "version", true)
}
