package discovery

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
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
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	path := filepath.Join(t.TempDir(), "history-fixture.json")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/history/testdata/interop.mjs"), "setup", path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if raw, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("actual history fixture %v %s", e, raw)
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var f Object
	if e = decode(raw, &f); e != nil {
		t.Fatal(e)
	}
	role, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src/infrastructure/worker-role.sql"))
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
	original := func(query Object, authenticated, indexed bool) []byte {
		t.Helper()
		script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{createServices}from './packages/galaxy-official/src/services.mjs';import{SearchIndex}from './packages/galaxy-official/src/discovery/search-index.mjs';import{generateKeyPairSync}from 'node:crypto';import{readFile}from 'node:fs/promises';const f=JSON.parse(await readFile(process.argv[1],'utf8')),db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{const s=createServices({db,endpoint:f.endpoint,kid:'fixture',signingKey:generateKeyPairSync('ed25519').privateKey,trustedKeys:new Map(f.trustedKeys),operator:'isolated',region:'test',now:()=>f.now,allowedScopes:['binding','consent','case-teaser','history']});if(process.argv[4]==='true')s.search.index=new SearchIndex({db,endpoint:f.endpoint,now:()=>f.now});const actor=process.argv[3]==='true'?await s.access.authenticate(f.owner.token,'history'):null;process.stdout.write(JSON.stringify(await s.search.query(actor,JSON.parse(process.argv[2]))))}finally{await db.end()}`
		return originalNode(t, dsn, true, script, path, jsonString(query), jsonString(authenticated), jsonString(indexed))
	}
	compare := func(q Object, a *deviceauth.Actor, indexed bool) {
		t.Helper()
		want := bytes.TrimSpace(original(q, a != nil, indexed))
		got, e := search.QueryWire(ctx, a, []byte(jsonString(q)))
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(got, want) {
			at := 0
			for at < min(len(got), len(want)) && got[at] == want[at] {
				at++
			}
			t.Errorf("legacy ordered wire differs at %d Go=%s JS=%s", at, got[max(0, at-25):min(len(got), at+120)], want[max(0, at-25):min(len(want), at+120)])
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
	compare(Object{"type": "case", "query": Object{"query": "compiler", "limit": 1}}, nil, true)
	// Source mutation invalidates the indexed generation. Even an existing cache
	// must never bypass the current read after one constituent consent is revoked.
	if _, e = owner.Exec(ctx, "UPDATE consents SET revoked_at=$2 WHERE id=$1", object(f["failedGrant"])["consentId"], now()); e != nil {
		t.Fatal(e)
	}
	compare(q, nil, true)
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
