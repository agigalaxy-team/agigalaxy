package subjectlifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func executionNode(t *testing.T, dsn, mode, path string, input any) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	command := exec.Command("node", filepath.Join(root, "go/internal/subjectlifecycle/testdata/execution.mjs"), mode, path)
	command.Dir = root
	command.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
	raw, _ := protocol.EncodeJS(input)
	command.Stdin = bytes.NewReader(raw)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	out, e := command.Output()
	if e != nil {
		t.Fatalf("original lifecycle %s %v %s", mode, e, stderr.String())
	}
	var value Object
	for _, line := range bytes.Split(out, []byte("\n")) {
		if json.Unmarshal(line, &value) == nil && value != nil {
			return value
		}
	}
	t.Fatal("fixture result")
	return nil
}
func executionSame(t *testing.T, a, b any) {
	t.Helper()
	var x, y any
	raw, _ := protocol.EncodeJS(a)
	_ = json.Unmarshal(raw, &x)
	raw, _ = protocol.EncodeJS(b)
	_ = json.Unmarshal(raw, &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("Go=%s\nJS=%s", mustExecutionJSON(a), mustExecutionJSON(b))
	}
}
func mustExecutionJSON(v any) []byte {
	raw, e := protocol.EncodeJS(v)
	if e != nil {
		panic(e)
	}
	return raw
}
func TestApprovedExecutionOriginalReceiptsForeignSnapshotsAndJSONBCopyErasure(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "execution-fixture.json")
	executionNode(t, dsn, "setup", path, nil)
	raw, _ := os.ReadFile(path)
	var fixture struct {
		Endpoint, Subject, Other                                   string
		Clock                                                      int64
		Approval                                                   json.RawMessage
		Command                                                    ExecutionCommand
		Root, First, Foreign, Task, Proposal, Application, Confirm Object
	}
	if e := json.Unmarshal(raw, &fixture); e != nil {
		t.Fatal(e)
	}
	rolePool := func(role string) *pgxpool.Pool {
		config := pool.Config()
		config.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE "+role); return e }
		p, e := pgxpool.NewWithConfig(ctx, config)
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(p.Close)
		return p
	}
	reviewer := rolePool("galaxy_deletion_reviewer")
	api := rolePool("galaxy_api")
	review, e := postgres.InTx(ctx, reviewer, func(tx pgx.Tx) (Object, error) { return ReviewDeletionWithin(ctx, tx, fixture.Approval) })
	if e != nil {
		t.Fatal(e)
	}
	if review["state"] != "approved" {
		t.Fatal(review)
	}
	if replay, e := postgres.InTx(ctx, reviewer, func(tx pgx.Tx) (Object, error) { return ReviewDeletionWithin(ctx, tx, fixture.Approval) }); e != nil {
		t.Fatal(e)
	} else {
		executionSame(t, replay, review)
	}
	if _, e = reviewer.Exec(ctx, `DELETE FROM case_events WHERE id=$1`, fixture.First["eventId"]); e == nil {
		t.Fatal("review role performed physical deletion")
	}
	product := &ProductDeletion{Forum: &community.Service{Pool: pool, Endpoint: fixture.Endpoint}, TaskSnapshots: TaskRedactors{Task: taskmaterials.RedactTaskSnapshot, Participation: taskmaterials.RedactParticipationSnapshot}}
	// Under the same verified approval, exercise the retained-copy minimizer
	// before the leaf pass. This is a component repair fixture, not a new Case
	// authoring route: all mixed-author events above were signed through Node.
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	prepared, e := PrepareExecutionWithin(ctx, tx, fixture.Command, fixture.Clock)
	if e != nil {
		t.Fatal(e)
	}
	info := DeletionInfo{SubjectID: fixture.Subject, RequestID: fixture.Command.RequestID, At: fixture.Clock, RetainedUntil: fixture.Clock + 100}
	var foreignBefore, foreignAfter string
	if e = tx.QueryRow(ctx, `SELECT payload::text FROM case_events WHERE id=$1`, fixture.Foreign["eventId"]).Scan(&foreignBefore); e != nil {
		t.Fatal(e)
	}
	var hashBefore string
	if e = tx.QueryRow(ctx, `SELECT payload_hash FROM case_events WHERE id=$1`, fixture.First["eventId"]).Scan(&hashBefore); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `UPDATE case_events SET payload_text='' WHERE id=$1`, fixture.First["eventId"]); e != nil {
		t.Fatal(e)
	}
	if _, e = product.MinimizeWithin(ctx, tx, info); e != nil {
		t.Fatal(e)
	}
	var payload, exact, hash string
	if e = tx.QueryRow(ctx, `SELECT payload::text,payload_text,payload_hash FROM case_events WHERE id=$1`, fixture.First["eventId"]).Scan(&payload, &exact, &hash); e != nil || payload != "{}" || exact != "" || hash != hashBefore {
		t.Fatalf("approved JSONB copy remained %s %s %v", payload, exact, e)
	}
	if e = tx.QueryRow(ctx, `SELECT payload::text FROM case_events WHERE id=$1`, fixture.Foreign["eventId"]).Scan(&foreignAfter); e != nil || foreignAfter != foreignBefore {
		t.Fatal("independent foreign event changed", e)
	}
	facts := cases.ProjectFacts([]cases.Object{{"id": fixture.First["eventId"], "kind": "attempt-start", "version": 2, "payload": protocol.NewOrderedObject(), "payload_text": "", "subject_id": fixture.Subject}}, cases.Object{"id": fixture.Root["caseId"], "version": 3})
	if len(facts["attempts"].([]any)) != 0 || len(facts["results"].([]any)) != 0 {
		t.Fatal("erased JSONB became a new fact")
	}
	if prepared.SubjectID != fixture.Subject {
		t.Fatal("wrong approved subject")
	}
	if e = tx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = postgres.InTx(ctx, api, func(tx pgx.Tx) (Object, error) {
		return ExecuteWithin(ctx, tx, fixture.Command, fixture.Clock, ExecutionOptions{Product: product})
	}); e == nil {
		t.Fatal("ordinary API pool executed closed maintenance")
	}
	tx, e = pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	goResult, e := ExecuteWithin(ctx, tx, fixture.Command, fixture.Clock, ExecutionOptions{Product: product})
	if e != nil {
		t.Fatal(e)
	}
	var foreignPayload string
	if e = tx.QueryRow(ctx, `SELECT payload_text FROM task_events WHERE id=$1`, objExecution(fixture.Application["event"])["eventId"]).Scan(&foreignPayload); e != nil || !strings.Contains(foreignPayload, "FOREIGN-INDEPENDENT-PROPOSAL") {
		t.Fatal("foreign Task event lost", e)
	}
	var snapshot string
	if e = tx.QueryRow(ctx, `SELECT snapshot::text FROM task_requests WHERE id=$1`, fixture.Task["taskId"]).Scan(&snapshot); e != nil || strings.Contains(snapshot, "PRIVATE-OWNER-ERASURE") {
		t.Fatal("owned task copy survived", e)
	}
	var participation string
	if e = tx.QueryRow(ctx, `SELECT snapshot::text FROM task_participations WHERE id=$1`, fixture.Proposal["participationId"]).Scan(&participation); e != nil || strings.Contains(participation, "PRIVATE-OWNER-ERASURE") || !strings.Contains(participation, text(fixture.Confirm["eventId"])) {
		t.Fatal("participation erasure removed independent event or retained owner scope", e)
	}
	if goResult["serviceWideDeletionComplete"] != false || goResult["storageMediaErasureVerified"] != false || goResult["state"] != "partial" {
		t.Fatal("database receipt overclaimed completion", goResult)
	}
	if e = tx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	// The original executor receives the exact Go-recorded approval and command.
	oracle := executionNode(t, dsn, "execute", path, nil)
	executionSame(t, goResult, oracle["execution"])
	before, e := onePoolExecution(ctx, pool, `SELECT revision FROM deletion_requests WHERE id=$1`, fixture.Command.RequestID)
	if e != nil {
		t.Fatal(e)
	}
	replayed, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return ExecuteWithin(ctx, tx, fixture.Command, fixture.Clock, ExecutionOptions{})
	})
	if e != nil {
		t.Fatal(e)
	}
	executionSame(t, replayed, oracle["execution"])
	after, e := onePoolExecution(ctx, pool, `SELECT revision FROM deletion_requests WHERE id=$1`, fixture.Command.RequestID)
	if e != nil || integer(after["revision"]) != integer(before["revision"]) {
		t.Fatal("prior execution was resent", e)
	}
	continued := fixture.Command
	continued.ID = uuid.NewString()
	continued.ExpectedRevision = integer(after["revision"])
	result, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return ExecuteWithin(ctx, tx, continued, fixture.Clock+101, ExecutionOptions{Product: product})
	})
	if e != nil {
		t.Fatal(e)
	}
	if result["state"] != "partial" || result["serviceWideDeletionComplete"] != false {
		t.Fatal(result)
	}
	var ownerControl int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM subjects WHERE id=$1`, fixture.Subject).Scan(&ownerControl); e != nil || ownerControl != 1 {
		t.Fatal("control history erased while foreign subject reference remains", e)
	}
}
func objExecution(v any) Object { o, _ := v.(Object); return o }
func onePoolExecution(ctx context.Context, pool *pgxpool.Pool, sql string, args ...any) (Object, error) {
	return postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return one(ctx, tx, sql, args...) })
}
