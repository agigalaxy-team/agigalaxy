package discovery

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/history"
	"github.com/agigalaxy-team/agigalaxy/go/internal/profiles"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyActualHistoryWireCandidateIndexAndRevocation(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	f := restoreDomainCapture(t, owner, "history", "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "audit_events", "cases", "case_events", "profile_statements")
	role, e := os.ReadFile(filepath.Join(root, "go/internal/databaseschema/sql/worker-role.sql"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, string(role)); e != nil {
		t.Fatal(e)
	}
	poolFor := func(role string) *pgxpool.Pool {
		t.Helper()
		cfg := owner.Config()
		cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE "+role); return e }
		pool, e := pgxpool.NewWithConfig(ctx, cfg)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(pool.Close)
		return pool
	}
	api, worker := poolFor("galaxy_api"), poolFor("galaxy_evidence_worker")
	now := func() time.Time { return time.Unix(number(f, "now"), 0) }
	endpoint := str(f, "endpoint")
	devices := &deviceauth.Service{Pool: api, Endpoint: endpoint, Now: now}
	profile := &profiles.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now}
	h := &history.Service{Pool: api, Endpoint: endpoint, Devices: devices, Profiles: profile, Now: now}
	index := &LegacyIndex{Pool: worker, Endpoint: endpoint, Now: now, Devices: &deviceauth.Service{Pool: worker, Endpoint: endpoint, Now: now}}
	search := &LegacySearch{Pool: api, Endpoint: endpoint, Devices: devices, HistoryQuery: h.QueryWire, Now: now}
	actor, e := devices.Authenticate(ctx, str(object(f["owner"]), "token"), "history")
	if e != nil {
		t.Fatal(e)
	}
	compare := func(q Object, a *deviceauth.Actor, indexed bool) {
		t.Helper()
		wire, e := search.QueryWire(ctx, a, []byte(jsonString(q)))
		if e != nil {
			t.Fatal(e)
		}
		if len(wire) == 0 {
			t.Fatal("missing source response")
		}
		if a == nil && (strings.Contains(string(wire), "private-tool") || strings.Contains(string(wire), str(f, "hidden"))) {
			t.Fatal("private history escaped", string(wire))
		}
	}
	q := Object{"type": "history", "query": Object{"subjectId": str(object(f["owner"]), "subject")}}
	compare(q, nil, false)
	compare(q, &actor, false)
	// Configure and process through the original limited
	// worker role, and serve candidates through the owning current History reader.
	if _, e = index.Configure(ctx, true, false); e != nil {
		t.Fatal(e)
	}
	if _, e = index.SeedBatch(ctx, 100); e != nil {
		t.Fatal(e)
	}
	for n := 0; n < 25; n++ {
		r, e := index.ProcessNext(ctx, LegacyProcessOptions{})
		if e != nil {
			t.Fatal(e)
		}
		if r["processed"] != true {
			break
		}
		if r["state"] == "pending" || r["state"] == "failed" {
			t.Fatalf("restricted index source failed %v", r)
		}
	}
	search.Index = &LegacyIndex{Pool: api, Endpoint: endpoint, Now: now}
	compare(q, nil, true)
	before, e := search.QueryWire(ctx, nil, []byte(jsonString(q)))
	if e != nil || !strings.Contains(string(before), str(f, "publicCase")) {
		t.Fatalf("qualified history absent %s %v", before, e)
	}
	compare(Object{"type": "case", "query": Object{"query": "compiler", "limit": 1}}, nil, true)
	// Source mutation invalidates the indexed generation. Even an existing cache
	// must never bypass the current read after one constituent consent is revoked.
	if _, e = owner.Exec(ctx, "UPDATE consents SET revoked_at=$2 WHERE id=$1", object(f["failedGrant"])["consentId"], now()); e != nil {
		t.Fatal(e)
	}
	compare(q, nil, true)
	after, e := search.QueryWire(ctx, nil, []byte(jsonString(q)))
	if e != nil || strings.Contains(string(after), str(f, "publicCase")) {
		t.Fatalf("revoked constituent remained searchable %s %v", after, e)
	}
	// Parser validation precedes owning source availability.
	invalid := []Object{{"type": "worker", "query": Object{"type": "worker"}}, {"type": "proof", "query": Object{"limit": 21}}, {"type": "capsule", "query": Object{"authorId": nil}}}
	for _, q := range invalid {
		if _, e = search.QueryWire(ctx, nil, []byte(jsonString(q))); e == nil {
			t.Fatalf("invalid source query accepted %s", jsonString(q))
		}
	}
	_, e = search.QueryWire(ctx, nil, []byte(`{"type":"capsule","query":{}}`))
	if e == nil {
		t.Fatal("missing owning capsule reader fabricated success")
	}
}
