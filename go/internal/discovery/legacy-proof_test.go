package discovery

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyProofCurrentSourceRestrictedIndexAndOrderedQuery(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	public, key, _ := ed25519.GenerateKey(rand.Reader)
	pem, _ := identity.PublicPEM(public)
	root, _ := filepath.Abs("../../..")
	path := filepath.Join(t.TempDir(), "evidence-fixture.json")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/evidence/testdata/interop.mjs"), "setup", path)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	cmd.Stdin = bytes.NewReader([]byte(jsonString(Object{"publicKey": pem})))
	if raw, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("original proof fixture %v %s", e, raw)
	}
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var f Object
	if e = decode(raw, &f); e != nil {
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
	wdevices := &deviceauth.Service{Pool: worker, Endpoint: endpoint, Now: now}
	es := &evidence.Service{Pool: worker, Endpoint: endpoint, Devices: wdevices, Now: now}
	es.LockCaseState = es.WorkerCaseStateWithin
	index := &LegacyIndex{Pool: worker, Endpoint: endpoint, Now: now, Devices: wdevices, Evidence: es}
	payload := Object{"sourceType": "proof", "sourceId": f["seedID"], "subjectId": object(f["owner"])["subject"], "generation": 1}
	tx, _ := worker.Begin(ctx)
	doc, e := index.build(ctx, tx, LegacyIndexJob{Payload: payload})
	_ = tx.Rollback(ctx)
	if e != nil {
		t.Fatal("actual restricted proof current source", e)
	}
	script := `import pg from './packages/galaxy-official/node_modules/pg/lib/index.js';import{createServices}from './packages/galaxy-official/src/services.mjs';import{SearchIndex}from './packages/galaxy-official/src/discovery/search-index.mjs';import{generateKeyPairSync}from 'node:crypto';import{readFile}from 'node:fs/promises';const f=JSON.parse(await readFile(process.argv[1],'utf8')),db=new pg.Pool({connectionString:process.env.GALAXY_GO_TEST_DATABASE_URL});try{const s=createServices({db,endpoint:f.endpoint,kid:'unused-fixture',signingKey:generateKeyPairSync('ed25519').privateKey,trustedKeys:new Map(f.pins),now:()=>f.clock,allowedScopes:['binding','consent','case-teaser','evidence','proof'],operator:'isolated',region:'test'});if(process.argv[2]==='build'){const index=new SearchIndex({db,endpoint:f.endpoint,now:()=>f.clock});console.log(JSON.stringify(await index.build(db,{payload:JSON.parse(process.argv[3])})))}else process.stdout.write(JSON.stringify(await s.search.query(null,JSON.parse(process.argv[3]))))}finally{await db.end()}`
	var expected Object
	if e = decode(originalNode(t, dsn, true, script, path, "build", jsonString(payload)), &expected); e != nil {
		t.Fatal(e)
	}
	got := Object{"type": doc.Type, "id": doc.ID, "subjectId": doc.SubjectID, "title": doc.Title, "summary": doc.Summary, "searchText": doc.SearchText, "version": doc.Version, "metadata": doc.Metadata, "dependencies": doc.Dependencies, "validUntil": doc.ValidUntil}
	if jsonString(got) != jsonString(expected) {
		var normalized Object
		_ = decode([]byte(jsonString(got)), &normalized)
		if jsonString(normalized) != jsonString(expected) {
			t.Fatalf("proof candidate differs Go=%s JS=%s", jsonString(got), jsonString(expected))
		}
	}
	pins := map[string]deviceauth.Pin{}
	for _, v := range f["pins"].([]any) {
		pair := v.([]any)
		p := object(pair[1])
		pins[pair[0].(string)] = deviceauth.Pin{PublicKeyPEM: str(p, "publicKeyPem"), NotBefore: number(p, "notBefore"), NotAfter: number(p, "notAfter"), Revoked: p["revoked"] == true}
	}
	ring := &deviceauth.SessionKeyring{Endpoint: endpoint, KID: "go-fixture", Key: key, Pins: func() map[string]deviceauth.Pin { return pins }}
	apiEvidence := &evidence.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now}
	caseService := &cases.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: now}
	proofs := &evidence.ProofService{Evidence: apiEvidence, Signer: ring, CaseContext: caseService.ProofCaseContextWithin}
	search := &LegacySearch{Pool: api, Endpoint: endpoint, Devices: devices, Proofs: proofs, Now: now}
	for _, query := range []Object{{"type": "proof", "query": Object{}}, {"type": "proof", "query": Object{"query": "synthetic success"}}} {
		want := bytes.TrimSpace(originalNode(t, dsn, true, script, path, "query", jsonString(query)))
		wire, e := search.QueryWire(ctx, nil, []byte(jsonString(query)))
		if e != nil {
			t.Fatal(e)
		}
		if !bytes.Equal(wire, want) {
			t.Fatalf("proof source whole wire differs Go=%s JS=%s", wire, want)
		}
	}
}
