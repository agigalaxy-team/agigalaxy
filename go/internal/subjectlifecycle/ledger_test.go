package subjectlifecycle

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestLedgerHistoricalSignaturesCaptureAndTerminalMinimizationOriginalInterop(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "execution-fixture.json")
	loadSyntheticExecution(t, pool, path)
	data, _ := os.ReadFile(path)
	var f struct {
		Endpoint string
		Clock    int64
		Approval ReviewCommand
	}
	if e := json.Unmarshal(data, &f); e != nil {
		t.Fatal(e)
	}
	reject := f.Approval
	reject.Decision = "reject"
	reject.Plan = nil
	reviewRaw, _ := protocol.EncodeJS(reject)
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return ReviewDeletionWithin(ctx, tx, reviewRaw) }); e != nil {
		t.Fatal(e)
	}
	captured, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return CaptureDeletionLedgerWithin(ctx, tx, f.Endpoint, func() int64 { return f.Clock }, nil)
	})
	if e != nil {
		t.Fatal(e)
	}
	originalCapture := originalProjection(t, "capture")
	if integer(captured["capturedAt"]) != integer(originalCapture["capturedAt"]) || integer(captured["requests"]) != integer(originalCapture["requests"]) || integer(captured["bytes"]) != integer(originalCapture["bytes"]) || text(captured["sha256"]) != identity.Digest([]byte(text(captured["payloadJson"]))) {
		t.Fatal("captured ledger metadata differs from original")
	}
	ledger, e := ValidateDeletionLedger([]byte(text(captured["payloadJson"])), nil)
	if e != nil {
		t.Fatal(e)
	}
	// Corrupt the original historical signer proof, never substitute current DB
	// authority for its signed bytes.
	bad := ledger
	bad.Tables = map[string][]Object{}
	for key, list := range ledger.Tables {
		bad.Tables[key] = append([]Object{}, list...)
	}
	eventCopy := Object{}
	for key, value := range bad.Tables["deletion_events"][0] {
		eventCopy[key] = value
	}
	eventCopy["signature"] = "bad"
	bad.Tables["deletion_events"][0] = eventCopy
	badRaw, _ := protocol.EncodeJS(bad)
	if _, e = ValidateDeletionLedger(badRaw, nil); e == nil {
		t.Fatal("invalid historical signature accepted")
	}
	command := MinimizationCommand{Version: 1, ID: uuid.NewString(), RequestID: reject.RequestID, Endpoint: f.Endpoint, ExpectedRevision: 2, OperatorRef: "isolated-minimizer", Policy: MinimizationPolicy{ID: "isolated-retention", Version: "1", NotBefore: f.Clock, Basis: "Terminal operator text minimization"}}
	raw, _ := protocol.EncodeJS(command)
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	minimized, e := MinimizeDeletionReceiptWithin(ctx, tx, raw, f.Clock, nil)
	if e != nil {
		t.Fatal(e)
	}
	var userBody, operatorBody string
	if e = tx.QueryRow(ctx, `SELECT payload_text FROM deletion_events WHERE request_id=$1 AND actor_kind='subject'`, reject.RequestID).Scan(&userBody); e != nil || userBody == "" {
		t.Fatal("signed user intent lost", e)
	}
	if e = tx.QueryRow(ctx, `SELECT payload_text FROM deletion_events WHERE id=$1`, reject.ID).Scan(&operatorBody); e != nil || operatorBody != "" {
		t.Fatal("operator text retained", e)
	}
	if e = tx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	js := originalProjection(t, "minimize")
	minimization := js["minimization"].(map[string]any)
	minimization["id"] = command.ID
	minimization["commandHash"] = identity.Digest(raw)
	// Row timestamps use the same original supplied clock; compact result equals
	// the original implementation including command hash and removed byte count.
	executionSame(t, minimized, js)
	committedMinimization, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return MinimizeDeletionReceiptWithin(ctx, tx, raw, f.Clock, nil) })
	if e != nil {
		t.Fatal(e)
	}
	executionSame(t, committedMinimization, js)
	replay, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return MinimizeDeletionReceiptWithin(ctx, tx, raw, f.Clock+10, nil) })
	if e != nil {
		t.Fatal(e)
	}
	executionSame(t, replay, js)
	after, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return CaptureDeletionLedgerWithin(ctx, tx, f.Endpoint, func() int64 { return f.Clock }, nil)
	})
	if e != nil {
		t.Fatal(e)
	}
	if _, e = ValidateDeletionLedger([]byte(text(after["payloadJson"])), nil); e != nil {
		t.Fatal(e)
	}
	// Restore this isolated request's older pre-minimization ledger. Its signed
	// subject row and immutable operator evidence are unchanged. Only mutable
	// state/operator compaction and the later event must be reconstructed.
	if _, e = pool.Exec(ctx, `DELETE FROM deletion_events WHERE id=$1`, command.ID); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `UPDATE deletion_events SET payload_text=$2,payload_minimized=false,retained_payload=NULL,retained_hash=NULL WHERE id=$1`, reject.ID, string(reviewRaw)); e != nil {
		t.Fatal(e)
	}
	request := ledger.Tables["deletion_requests"][0]
	if _, e = pool.Exec(ctx, `UPDATE deletion_requests SET revision=2,updated_at=$2,minimized_at=NULL WHERE id=$1`, reject.RequestID, ledgerTime(request["updated_at"])); e != nil {
		t.Fatal(e)
	}
	recoveryID := uuid.NewString()
	if _, e = pool.Exec(ctx, `INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status)VALUES(true,$1,'isolated-explicit-backup','quarantined')`, recoveryID); e != nil {
		t.Fatal(e)
	}
	replayCommand := ReplayCommand{Version: 1, ID: uuid.NewString(), RecoveryID: recoveryID, Endpoint: f.Endpoint, LedgerSHA256: text(after["sha256"]), CapturedNotBefore: f.Clock, ExecutorRef: "isolated-executor"}
	replayRaw, _ := protocol.EncodeJS(replayCommand)
	restored, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return ReplayDeletionLedgerWithin(ctx, tx, []byte(text(after["payloadJson"])), replayRaw, f.Clock, nil, nil)
	})
	if e != nil {
		t.Fatal(e)
	}
	if restored["publicActivationReady"] != false || integer(restored["requestsReplayed"]) != 0 || integer(restored["executionsReplayed"]) != 0 {
		t.Fatal("nonexecuted request became deletion", restored)
	}
	prior, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return ReplayDeletionLedgerWithin(ctx, tx, []byte(text(after["payloadJson"])), replayRaw, f.Clock+100, nil, nil)
	})
	if e != nil {
		t.Fatal(e)
	}
	executionSame(t, prior, restored)
	if _, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return CaptureDeletionLedgerWithin(ctx, tx, f.Endpoint, func() int64 { return f.Clock }, nil)
	}); e != nil {
		t.Fatal("reconstructed complete ledger", e)
	}
}

func TestReplayExecutedLedgerOriginalQuarantinePassAndReceipt(t *testing.T) {
	pool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	path := filepath.Join(t.TempDir(), "execution-fixture.json")
	loadSyntheticExecution(t, pool, path)
	data, _ := os.ReadFile(path)
	var f struct {
		Endpoint string
		Clock    int64
		Approval json.RawMessage
		Command  ExecutionCommand
	}
	if e := json.Unmarshal(data, &f); e != nil {
		t.Fatal(e)
	}
	product := &ProductDeletion{Forum: &community.Service{Endpoint: f.Endpoint}, TaskSnapshots: TaskRedactors{Task: taskmaterials.RedactTaskSnapshot, Participation: taskmaterials.RedactParticipationSnapshot}}
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) { return ReviewDeletionWithin(ctx, tx, f.Approval) }); e != nil {
		t.Fatal(e)
	}
	if _, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return ExecuteWithin(ctx, tx, f.Command, f.Clock, ExecutionOptions{Product: product})
	}); e != nil {
		t.Fatal(e)
	}
	capture, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return CaptureDeletionLedgerWithin(ctx, tx, f.Endpoint, func() int64 { return f.Clock }, nil)
	})
	if e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	if _, e = pool.Exec(ctx, `INSERT INTO recovery_state(singleton,recovery_id,snapshot_id,status)VALUES(true,$1,'isolated-approved-execution','quarantined')`, id); e != nil {
		t.Fatal(e)
	}
	c := ReplayCommand{Version: 1, ID: uuid.NewString(), RecoveryID: id, Endpoint: f.Endpoint, LedgerSHA256: text(capture["sha256"]), CapturedNotBefore: f.Clock, ExecutorRef: "isolated-executor"}
	raw, _ := protocol.EncodeJS(c)
	tx, e := pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	goResult, e := ReplayDeletionLedgerWithin(ctx, tx, []byte(text(capture["payloadJson"])), raw, f.Clock, product, nil)
	if e != nil {
		t.Fatal(e)
	}
	if integer(goResult["requestsReplayed"]) != 1 || integer(goResult["executionsReplayed"]) < 1 || goResult["quarantined"] != true || goResult["publicActivationReady"] != false {
		t.Fatal(goResult)
	}
	if e = tx.Rollback(ctx); e != nil {
		t.Fatal(e)
	}
	original := originalProjection(t, "replay")
	original["id"], original["recoveryId"], original["ledgerSha256"] = c.ID, c.RecoveryID, c.LedgerSHA256
	// Explicit restored-copy passes own new internal execution UUIDs in both
	// implementations. Compare all remaining receipt fields/counters exactly.
	normalizeIDs := func(value Object) Object {
		raw, _ := protocol.EncodeJS(value)
		var result Object
		_ = json.Unmarshal(raw, &result)
		for _, entry := range result["results"].([]any) {
			entry.(map[string]any)["executionId"] = "<restored-copy-operation>"
		}
		return result
	}
	executionSame(t, normalizeIDs(goResult), normalizeIDs(original))
	committed, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return ReplayDeletionLedgerWithin(ctx, tx, []byte(text(capture["payloadJson"])), raw, f.Clock, product, nil)
	})
	if e != nil {
		t.Fatal(e)
	}
	executionSame(t, normalizeIDs(committed), normalizeIDs(original))
	prior, e := postgres.InTx(ctx, pool, func(tx pgx.Tx) (Object, error) {
		return ReplayDeletionLedgerWithin(ctx, tx, []byte(text(capture["payloadJson"])), raw, f.Clock+10, nil, nil)
	})
	if e != nil {
		t.Fatal(e)
	}
	executionSame(t, prior, committed)
}
