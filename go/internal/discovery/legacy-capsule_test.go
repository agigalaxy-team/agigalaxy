package discovery

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/capsules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyCapsuleCandidateUsesPublicVersionAndCurrentPrivateSource(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	f := restoreDomainCapture(t, pool, "capsules", "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "audit_events", "cases", "case_events", "verification_objects", "verification_events", "verification_dependencies")
	endpoint := str(f, "endpoint")
	now := func() time.Time { return time.Unix(number(f, "clock"), 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: endpoint, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now}
	records := &verificationrecords.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Cases: cs, Now: now}
	config := &configurations.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now}
	svc := &capsules.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Cases: cs, Records: records, Configurations: config, Now: now}
	actor, e := devices.Authenticate(ctx, str(object(f["owner"]), "token"), "capsules")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = svc.Publish(ctx, actor, []byte(jsonString(f["legacyGrant"])), ""); e != nil {
		t.Fatal(e)
	}
	version := object(f["legacyVersion"])
	var rootConsent string
	if e = pool.QueryRow(ctx, `SELECT consent_id::text FROM case_events WHERE case_id=$1 AND kind='case'`, object(version["sourceResolution"])["caseId"]).Scan(&rootConsent); e != nil {
		t.Fatal(e)
	}
	payload := Object{"sourceType": "capsule", "sourceId": version["capsuleId"], "subjectId": actor.SubjectID, "generation": 1}
	root, _ := filepath.Abs("../../..")
	sql, e := os.ReadFile(filepath.Join(root, "go/internal/databaseschema/sql/worker-role.sql"))
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
	index := &LegacyIndex{Pool: worker, Endpoint: endpoint, Now: now, Devices: &deviceauth.Service{Pool: worker, Endpoint: endpoint, Now: now}}
	build := func() (*LegacyDocument, error) {
		tx, e := worker.Begin(ctx)
		if e != nil {
			return nil, e
		}
		defer tx.Rollback(ctx)
		return index.build(ctx, tx, LegacyIndexJob{Payload: payload})
	}
	doc, e := build()
	if e != nil {
		t.Fatal(e)
	}
	if doc == nil || doc.ID != str(version, "capsuleId") || doc.Title != str(version, "title") {
		t.Fatalf("current capsule candidate %+v", doc)
	}
	if _, e = pool.Exec(ctx, "UPDATE consents SET revoked_at=$2 WHERE id=$1", rootConsent, now()); e != nil {
		t.Fatal(e)
	}
	if _, e = build(); e == nil || !hiddenLegacySource(e) {
		t.Fatalf("revoked underlying private source retained public candidate %v", e)
	}
}
