package discovery

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyProofCurrentSourceRestrictedIndexAndOrderedQuery(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	seed := sha256.Sum256([]byte("galaxy-synthetic-evidence-signing-fixture"))
	key := ed25519.NewKeyFromSeed(seed[:])
	f := restoreDomainCapture(t, owner, "evidence", "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "cases", "case_events", "evidence_submissions", "jobs", "verification_attempts", "proofs", "audit_events")
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
	if doc == nil || doc.ID != str(f, "seedID") || doc.Type != "proof" {
		t.Fatalf("restricted current proof candidate %+v", doc)
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
		wire, e := search.QueryWire(ctx, nil, []byte(jsonString(query)))
		if e != nil {
			t.Fatal(e)
		}
		if len(wire) == 0 {
			t.Fatal("missing proof query response")
		}

	}
}
