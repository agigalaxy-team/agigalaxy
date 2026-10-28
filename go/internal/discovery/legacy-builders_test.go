package discovery

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyBuilderOwningWireAndRestrictedIndex(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	path := filepath.Join(t.TempDir(), "builder-fixture.json")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/builders/testdata/interop.mjs"), "setup", path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	if raw, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("actual builder fixture %v %s", e, raw)
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var f Object
	if e = decode(raw, &f); e != nil {
		t.Fatal(e)
	}
	workerSQL, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src/infrastructure/worker-role.sql"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = owner.Exec(ctx, string(workerSQL)); e != nil {
		t.Fatal(e)
	}
	poolFor := func(role string) *pgxpool.Pool {
		t.Helper()
		cfg := owner.Config()
		cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE "+role); return e }
		p, e := pgxpool.NewWithConfig(ctx, cfg)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(p.Close)
		return p
	}
	api, worker := poolFor("galaxy_api"), poolFor("galaxy_evidence_worker")
	endpoint := str(f, "endpoint")
	now := func() time.Time { return time.Unix(number(f, "clock"), 0) }
	devices := &deviceauth.Service{Pool: api, Endpoint: endpoint, Now: now}
	config := &configurations.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now}
	cs := &cases.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now, ConfigurationCondition: config.ConditionWithin}
	records := &verificationrecords.Service{Pool: api, Endpoint: endpoint, Devices: devices, Cases: cs, Now: now}
	source := &builders.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now, Cases: cs, Configurations: config, VerificationRecords: records}
	a, e := devices.Authenticate(ctx, str(object(f["owner"]), "token"), "builders")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = source.Publish(ctx, a, []byte(jsonString(f["declareGrant"])), ""); e != nil {
		t.Fatal("actual declaration", e)
	}
	hubFixture := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{serviceFixture}from './packages/galaxy-official/test/service-fixture.mjs';import{builderDeclaration}from './packages/galaxy-official/test/builders-workflow.mjs';import{randomUUID}from 'node:crypto';const db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{const f=await serviceFixture(['binding','consent','builders'],db,{endpoint:process.argv[1],now:Number(process.argv[2]),migrateDatabase:false}),event={id:randomUUID(),builderId:randomUUID(),kind:'declare',expectedRevision:0,declaration:builderDeclaration('hub',f.actor.subjectId)};await f.builders.publish(f.actor,await f.authorize(event,'builder.publish',{visibility:'Public',purpose:'public-profile'}));console.log('{}')}finally{await db.end()}`
	originalNode(t, dsn, true, hubFixture, endpoint, jsonString(number(f, "clock")))
	search := &LegacySearch{Endpoint: endpoint, Now: now, BuildersQuery: func(ctx context.Context, a *deviceauth.Actor, raw []byte, ids []string) (json.RawMessage, error) {
		return source.QueryWire(ctx, a, raw, builders.QueryOptions{PublicOnly: true, SourceSearch: true, CandidateIDs: ids})
	}}
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{createServices}from './packages/galaxy-official/src/services.mjs';import{generateKeyPairSync}from 'node:crypto';import{readFile}from 'node:fs/promises';const f=JSON.parse(await readFile(process.argv[1],'utf8')),db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{const s=createServices({db,endpoint:f.endpoint,kid:'unused-fixture',signingKey:generateKeyPairSync('ed25519').privateKey,trustedKeys:new Map(f.pins??[]),now:()=>f.clock,allowedScopes:['binding','consent','builders','history','case-teaser','evidence','proof'],operator:'isolated',region:'test'});process.stdout.write(JSON.stringify(await s.search.query(null,JSON.parse(process.argv[2]))))}finally{await db.end()}`
	index := &LegacyIndex{Pool: worker, Endpoint: endpoint, Now: now, Devices: &deviceauth.Service{Pool: worker, Endpoint: endpoint, Now: now}}
	if _, e = index.Configure(ctx, true, false); e != nil {
		t.Fatal(e)
	}
	if _, e = index.SeedBatch(ctx, 100); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 40; i++ {
		r, e := index.ProcessNext(ctx, LegacyProcessOptions{})
		if e != nil {
			t.Fatal(e)
		}
		if r["processed"] != true {
			break
		}
		if r["state"] == "pending" || r["state"] == "failed" {
			t.Fatalf("restricted builder index failed %v", r)
		}
	}
	for _, kind := range []string{"worker", "hub"} {
		search.Index = &LegacyIndex{Pool: api, Endpoint: endpoint, Now: now}
		q := Object{"type": kind, "query": Object{}}
		want := bytes.TrimSpace(originalNode(t, dsn, true, script, path, jsonString(q)))
		wire, e := search.QueryWire(ctx, nil, []byte(jsonString(q)))
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(wire, want) {
			at := 0
			for at < min(len(wire), len(want)) && wire[at] == want[at] {
				at++
			}
			t.Fatalf("builder owning wire differs at %d Go=%s JS=%s", at, wire[max(0, at-20):min(len(wire), at+100)], want[max(0, at-20):min(len(want), at+100)])
		}
		if kind == "worker" || kind == "hub" {
			page, e := orderedPage(wire)
			if e != nil || len(page["items"].([]any)) != 1 {
				t.Fatalf("published %s was absent from actual candidates %s %v", kind, wire, e)
			}
		}
	}
}
