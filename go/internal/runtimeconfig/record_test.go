package runtimeconfig

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOriginalRuntimeConfigurationLedgerInterop(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	var fixture struct {
		Values, RecordInput Object
		Event               Event
	}
	raw, e := os.ReadFile("testdata/runtime-config-setup.json")
	if e != nil {
		t.Fatal(e)
	}
	if e := json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e)
	}
	if _, e := databaseschema.Migrate(ctx, owner, []string{"api"}); e != nil {
		t.Fatal(e)
	}
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	built, e := Build(fixture.Values)
	if e != nil {
		t.Fatal(e)
	}
	if !equal(built, fixture.RecordInput["snapshot"]) {
		t.Fatalf("snapshot differs\nGo %s\nJS %s", jsonText(built), jsonText(fixture.RecordInput["snapshot"]))
	}
	oracleRaw, e := os.ReadFile("testdata/runtime-config-oracle.json")
	if e != nil {
		t.Fatal(e)
	}
	var oracle Object
	if e = json.Unmarshal(oracleRaw, &oracle); e != nil {
		t.Fatal(e)
	}
	prepared, _, e := prepareRegistries(fixture.RecordInput)
	if e != nil {
		t.Fatal(e)
	}
	snap := object(prepared["snapshot"])
	for key, other := range map[string]string{"honorRegistry": "honor", "qualificationRegistry": "qualification", "experienceReviewerRegistry": "experience"} {
		if !equal(snap[key], oracle[other]) {
			t.Fatalf("%s normalization mismatch Go %s JS %s", key, jsonText(snap[key]), jsonText(oracle[other]))
		}
	}
	if e = VerifyEvent(fixture.Event); e != nil {
		t.Fatalf("JS event verify %v", e)
	}
	opts := Options{Now: func() time.Time { return time.Unix(2000000000, 0) }}
	initial, e := Record(ctx, pool, fixture.RecordInput, opts)
	baseline := fixture.Event
	baseline.CreatedAt = initial.CreatedAt // database insertion time is independent of observedAt
	if e != nil || !equal(initial, baseline) {
		t.Fatalf("fixed historical event differs %v\nGo%s\nFixture%s", e, jsonText(initial), jsonText(fixture.Event))
	}
	if _, e = time.Parse(time.RFC3339Nano, initial.CreatedAt); e != nil {
		t.Fatal(e)
	}
	// Seed the retained historical insertion timestamp, then require the normal
	// idempotent read to return that original row without restamping it.
	if _, e = owner.Exec(ctx, "UPDATE runtime_config_events SET created_at=$2 WHERE id=$1", fixture.Event.ID, fixture.Event.CreatedAt); e != nil {
		t.Fatal(e)
	}
	retry, e := Record(ctx, pool, fixture.RecordInput, opts)
	if e != nil || !equal(retry, fixture.Event) {
		t.Fatalf("JS→Go idempotency %v", e)
	}
	next := object(clone(fixture.RecordInput))
	next["id"] = uuid.NewString()
	object(next["snapshot"])["requestQuotaHash"] = strings.Repeat("b", 64)
	row, e := Record(ctx, pool, next, opts)
	if e != nil {
		t.Fatal(e)
	}
	if e = VerifyEvent(row); e != nil {
		t.Fatal(e)
	}
	if row.Payload["previousHash"] != fixture.Event.EventHash {
		t.Fatal("history link lost")
	}
	conflict := object(clone(next))
	object(conflict["snapshot"])["requestQuotaHash"] = strings.Repeat("c", 64)
	if _, e = Record(ctx, pool, conflict, opts); e == nil || e.Error() != "Runtime configuration operation conflict" {
		t.Fatalf("operation conflict %v", e)
	}
	for _, kind := range []string{"honorRules", "qualificationPolicies", "experienceReviewers"} {
		input := object(clone(next))
		input["id"] = uuid.NewString()
		delete(input, kind)
		if _, e = Record(ctx, pool, input, opts); e == nil {
			t.Fatalf("%s silently removed", kind)
		}
	}
	for _, kind := range []string{"honorRules", "qualificationPolicies"} {
		input := object(clone(next))
		input["id"] = uuid.NewString()
		object(array(input[kind])[0])["title"] = "Changed same version"
		values := object(clone(fixture.Values))
		object(values["governance"])[kind] = input[kind]
		snapshot, e := Build(values)
		if e != nil {
			t.Fatal(e)
		}
		input["snapshot"] = snapshot
		if _, e = Record(ctx, pool, input, opts); e == nil || !strings.Contains(e.Error(), "version conflict") {
			t.Fatalf("%s immutable version: %v", kind, e)
		}
	}
	incidentRemoval := object(clone(next))
	incidentRemoval["id"] = uuid.NewString()
	object(incidentRemoval["snapshot"])["incident"] = nil
	if _, e = Record(ctx, pool, incidentRemoval, opts); e == nil || e.Error() != "Active incident cannot be removed" {
		t.Fatalf("incident removal %v", e)
	}
	var count int
	if e = owner.QueryRow(ctx, "SELECT count(*) FROM runtime_config_events").Scan(&count); e != nil || count != 2 {
		t.Fatalf("failed changes committed %d %v", count, e)
	}
	page, e := ExportPage(ctx, pool, Object{"endpoint": fixture.RecordInput["endpoint"], "component": "api", "limit": 1})
	if e != nil || page["hasMore"] != true {
		t.Fatalf("archive first %v", e)
	}
	nextPage, e := ExportPage(ctx, pool, Object{"endpoint": fixture.RecordInput["endpoint"], "component": "api", "after": num(page["nextCursor"]), "limit": 1})
	if e != nil || nextPage["lastHash"] != row.EventHash {
		t.Fatalf("archive anchor %v", e)
	}
	pageBody := object(clone(nextPage))
	delete(pageBody, "sha256")
	canonical, err := identity.Canonical(pageBody)
	if err != nil || identity.Digest(canonical) != nextPage["sha256"] {
		t.Fatalf("archive page bytes/hash mismatch %v", err)
	}
	if _, e = ExportPage(ctx, pool, Object{"endpoint": fixture.RecordInput["endpoint"], "component": "api", "after": 999}); e == nil || e.Error() != "Runtime configuration archive cursor unavailable" {
		t.Fatalf("missing cursor %v", e)
	}
	tampered := row
	tampered.Payload = object(clone(row.Payload))
	tampered.Payload["outcome"] = "tampered"
	if VerifyEvent(tampered) == nil {
		t.Fatal("tampered history accepted")
	}

	reviewValues := Object{"governance": Object{}}
	reviewSnap, e := Build(reviewValues)
	if e != nil {
		t.Fatal(e)
	}
	confHash := object(reviewSnap["governance"])["configurationSha256"]
	review := Object{"version": 1, "changeId": uuid.NewString(), "endpoint": fixture.RecordInput["endpoint"], "revision": 1, "previousConfigurationSha256": nil, "configurationSha256": confHash, "requesterKid": "requester", "reviewerKid": "reviewer", "issuedAt": 1999999900, "expiresAt": 2000000600, "authoritiesSha256": strings.Repeat("a", 64), "requestSignatureSha256": strings.Repeat("b", 64), "reviewSignatureSha256": strings.Repeat("c", 64)}
	object(reviewSnap["governance"])["review"] = review
	worker := Object{"endpoint": fixture.RecordInput["endpoint"], "component": "worker", "snapshot": reviewSnap}
	reviewed, e := Record(ctx, pool, worker, opts)
	if e != nil {
		t.Fatalf("reviewed observation %v", e)
	}
	for _, change := range []string{"remove", "same-id-modified", "revision-gap", "wrong-previous", "wrong-configuration"} {
		command := object(clone(worker))
		command["id"] = uuid.NewString()
		gov := object(object(command["snapshot"])["governance"])
		r := object(gov["review"])
		switch change {
		case "remove":
			gov["review"] = nil
		case "same-id-modified":
			r["requestSignatureSha256"] = strings.Repeat("d", 64)
		case "revision-gap":
			r["changeId"] = uuid.NewString()
			r["revision"] = 3
		case "wrong-previous":
			r["changeId"] = uuid.NewString()
			r["revision"] = 2
			r["previousConfigurationSha256"] = strings.Repeat("d", 64)
		case "wrong-configuration":
			r["configurationSha256"] = strings.Repeat("d", 64)
		}
		if _, e = Record(ctx, pool, command, opts); e == nil {
			t.Fatalf("governance %s accepted", change)
		}
	}
	validNext := object(clone(worker))
	validNext["id"] = uuid.NewString()
	r := object(object(object(validNext["snapshot"])["governance"])["review"])
	r["changeId"] = uuid.NewString()
	r["revision"] = 2
	r["previousConfigurationSha256"] = confHash
	nextReviewed, e := Record(ctx, pool, validNext, opts)
	if e != nil {
		t.Fatalf("next reviewed revision %v", e)
	}
	for _, event := range []Event{fixture.Event, row, reviewed, nextReviewed} {
		if e := VerifyEvent(event); e != nil {
			t.Fatal(e)
		}
	}
	t.Log("original JS↔Go snapshot, registry, ledger hashes, API-role record/retry/rollback, reviewed governance and archive interop passed")
}
func TestScalarCanonicalAndSectionDifference(t *testing.T) {
	for _, pair := range [][2]any{{"old", "new"}, {nil, ""}, {int64(1), int64(2)}, {true, false}} {
		if equal(pair[0], pair[1]) {
			t.Fatalf("distinct scalar values compared equal: %v", pair)
		}
	}
	before := Object{"version": 1, "requestQuotaHash": "old", "governance": nil}
	after := Object{"version": 1, "requestQuotaHash": "new", "governance": nil}
	got := difference(before, after)
	if jsonText(got["changedSections"]) != `["requestQuotaHash"]` {
		t.Fatalf("scalar changes disappeared %s", jsonText(got))
	}
}
