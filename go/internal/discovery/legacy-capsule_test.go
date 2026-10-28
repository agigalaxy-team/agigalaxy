package discovery

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyCapsuleCandidateUsesPublicVersionAndCurrentPrivateSource(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	var f Object
	if e := decode(originalNode(t, dsn, false, "setup"), &f); e != nil {
		t.Fatal(e)
	}
	endpoint := str(f, "endpoint")
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{serviceFixture}from './packages/galaxy-official/test/service-fixture.mjs';import{SearchIndex}from './packages/galaxy-official/src/discovery/search-index.mjs';import{randomUUID}from 'node:crypto';const db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{const f=await serviceFixture(['binding','consent','case-teaser','capsules'],db,{endpoint:process.argv[1],now:2000000000,migrateDatabase:false}),root={kind:'case',id:randomUUID(),localRef:randomUUID(),title:'Selected private source',summary:'Synthetic retained source',source:{kind:'local',reference:randomUUID()},participants:[{subjectId:f.actor.subjectId,role:'requester'}]};const rootGrant=await f.authorize(root);await f.cases.submit(f.actor,rootGrant);const attempt={kind:'attempt',id:randomUUID(),caseId:root.id,expectedVersion:1,sequence:1,approach:'Selected report',configuration:{environment:'fixture',version:'1',tools:[]}};await f.cases.submit(f.actor,await f.authorize(attempt));const result={kind:'result',id:randomUUID(),caseId:root.id,expectedVersion:2,attemptId:attempt.id,outcome:'succeeded',summary:'Owner report',failureReason:'',limitations:['Synthetic only']};await f.cases.submit(f.actor,await f.authorize(result));const version={id:randomUUID(),capsuleId:randomUUID(),kind:'version',expectedRevision:0,version:1,title:'Selected compiler method',problemPattern:'Synthetic package mismatch',environment:{name:'fixture',version:'1'},solutionStrategy:'Check selected dependencies',tools:[],skills:[],mcpRefs:[],verificationMethod:'Author report only',limitations:['Synthetic only'],capabilityId:'compiler',applicableScope:'Selected example',license:'MIT',contributors:[],sourceResolution:{caseId:root.id,resultId:result.id,proofIds:[]},redactionConfirmed:true};await f.capsules.publish(f.actor,await f.authorize(version,'capsule.publish',{visibility:'Public',purpose:'public-profile'}));const payload={sourceType:'capsule',sourceId:version.capsuleId,subjectId:f.actor.subjectId,generation:1},index=new SearchIndex({db,endpoint:f.bindings.endpoint,now:()=>2000000000});console.log(JSON.stringify({payload,rootConsent:rootGrant.consentId,document:await index.build(db,{payload})}))}finally{await db.end()}`
	var fixture Object
	if e := decode(originalNode(t, dsn, true, script, endpoint), &fixture); e != nil {
		t.Fatal(e)
	}
	root, _ := filepath.Abs("../../..")
	sql, e := os.ReadFile(filepath.Join(root, "packages/galaxy-official/src/infrastructure/worker-role.sql"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, string(sql)); e != nil {
		t.Fatal(e)
	}
	cfg := pool.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	index := &LegacyIndex{Pool: worker, Endpoint: endpoint, Now: now, Devices: &deviceauth.Service{Pool: worker, Endpoint: endpoint, Now: now}}
	build := func() (*LegacyDocument, error) {
		tx, e := worker.Begin(ctx)
		if e != nil {
			return nil, e
		}
		defer tx.Rollback(ctx)
		return index.build(ctx, tx, LegacyIndexJob{Payload: object(fixture["payload"])})
	}
	doc, e := build()
	if e != nil {
		t.Fatal(e)
	}
	got := Object{"type": doc.Type, "id": doc.ID, "subjectId": doc.SubjectID, "title": doc.Title, "summary": doc.Summary, "searchText": doc.SearchText, "version": doc.Version, "metadata": doc.Metadata, "dependencies": doc.Dependencies, "validUntil": doc.ValidUntil}
	var normalized Object
	_ = decode([]byte(jsonString(got)), &normalized)
	if !reflect.DeepEqual(normalized, object(fixture["document"])) {
		t.Fatalf("capsule candidate differs Go=%s JS=%s", jsonString(got), jsonString(fixture["document"]))
	}
	if _, e = pool.Exec(ctx, "UPDATE consents SET revoked_at=$2 WHERE id=$1", fixture["rootConsent"], now()); e != nil {
		t.Fatal(e)
	}
	if _, e = build(); e == nil || !hiddenLegacySource(e) {
		t.Fatalf("revoked underlying private source retained public candidate %v", e)
	}
}
