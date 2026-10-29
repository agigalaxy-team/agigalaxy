package discovery

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/builders"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/configurations"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyBuilderOwningWireAndRestrictedIndex(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 55*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	f := restoreDomainCapture(t, owner, "builders", "subjects", "binding_challenges", "bindings", "access_credentials", "consents", "audit_events", "cases", "case_events", "configuration_objects", "configuration_events")
	workerSQL, e := os.ReadFile(filepath.Join(root, "go/internal/databaseschema/sql/worker-role.sql"))
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
	hub := deviceauthfixture.NewEndpoint(t, owner, t.TempDir(), []string{"binding", "consent", "builders"}, endpoint)
	declaration := object(merge(Object{}, object(f["declare"]))["declaration"])
	delete(declaration, "nodeId")
	delete(declaration, "configuration")
	delete(declaration, "capabilities")
	declaration["type"], declaration["name"] = "hub", "Synthetic hub"
	declaration["operator"], declaration["charter"], declaration["region"], declaration["endpoint"] = "Fixture operator", "https://hub.example/charter", "Fixture", "https://hub.example"
	declaration["manifest"] = Object{"url": "https://hub.example/manifest", "sha256": strings.Repeat("d", 64), "specVersion": "unimplemented-fixture"}
	declaration["exit"], declaration["export"] = "Revoke binding", "Owner exports selected data"
	event := Object{"id": uuid.NewString(), "builderId": uuid.NewString(), "kind": "declare", "expectedRevision": 0, "declaration": declaration}
	payload := jsonString(event)
	intent := deviceauth.ConsentIntent{Version: 1, ID: uuid.NewString(), SubjectID: hub.Actor.SubjectID, BindingID: hub.Actor.BindingID, Endpoint: endpoint, ObjectID: str(event, "id"), Action: "builder.publish", Purpose: "public-profile", Recipient: endpoint, Fields: []string{"id", "builderId", "expectedRevision", "kind", "declaration"}, Visibility: "Public", Viewers: []string{}, PayloadHash: identity.Digest([]byte(payload)), PolicyVersion: "0.1", IssuedAt: number(f, "clock"), ExpiresAt: number(f, "clock") + 3600}
	key, e := identity.PrivatePEM([]byte(hub.Materials.OwnerPrivate))
	if e != nil {
		t.Fatal(e)
	}
	signature, e := identity.SignIdentityPayload(key, jsonString(intent), "galaxy-consent+jws")
	if e != nil {
		t.Fatal(e)
	}
	grant, e := hub.Service.CaptureConsent(ctx, hub.Actor, signature)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = source.Publish(ctx, hub.Actor, []byte(jsonString(Object{"consentId": grant.ConsentID, "payloadJson": payload})), ""); e != nil {
		t.Fatal("actual hub declaration", e)
	}
	search := &LegacySearch{Endpoint: endpoint, Now: now, BuildersQuery: func(ctx context.Context, a *deviceauth.Actor, raw []byte, ids []string) (json.RawMessage, error) {
		return source.QueryWire(ctx, a, raw, builders.QueryOptions{PublicOnly: true, SourceSearch: true, CandidateIDs: ids})
	}}
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
		wire, e := search.QueryWire(ctx, nil, []byte(jsonString(q)))
		if e != nil {
			t.Fatal(e)
		}

		if kind == "worker" || kind == "hub" {
			page, e := orderedPage(wire)
			if e != nil || len(page["items"].([]any)) != 1 {
				t.Fatalf("published %s was absent from actual candidates %s %v", kind, wire, e)
			}
		}
	}
}
