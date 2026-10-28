package subjectlifecycle

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type ReplayCommand struct {
	Version           int    `json:"version"`
	ID                string `json:"id"`
	RecoveryID        string `json:"recoveryId"`
	Endpoint          string `json:"endpoint"`
	LedgerSHA256      string `json:"ledgerSha256"`
	CapturedNotBefore int64  `json:"capturedNotBefore"`
	ExecutorRef       string `json:"executorRef"`
}

func decimalLedger(n int) string { return strconv.Itoa(n) }
func ledgerTime(v any) any {
	if s, ok := v.(string); ok {
		if at, e := time.Parse(time.RFC3339Nano, s); e == nil {
			return at
		}
	}
	return v
}

// ReplayDeletionLedgerWithin imports an independently captured, verified ledger
// only into its exact quarantined restore. The caller owns the maintenance
// transaction. Approval without a prior execution is imported but never run.
func ReplayDeletionLedgerWithin(ctx context.Context, tx pgx.Tx, payload []byte, commandRaw []byte, at int64, product ProductDeletionConsumer, control HistoricalControlVerifier) (Object, error) {
	var c ReplayCommand
	if !requiredFields(commandRaw, "version", "id", "recoveryId", "endpoint", "ledgerSha256", "capturedNotBefore", "executorRef") || protocol.Decode(commandRaw, &c) != nil || c.Version != 1 || !validID(c.ID) || !validID(c.RecoveryID) || !ledgerOrigin(c.Endpoint) || !hashPattern.MatchString(c.LedgerSHA256) || !safeNonnegative(c.CapturedNotBefore) || !operatorRef.MatchString(c.ExecutorRef) {
		return nil, errors.New("invalid deletion replay command")
	}
	if len(payload) > ledgerLimit || identity.Digest(payload) != c.LedgerSHA256 {
		return nil, errors.New("deletion ledger digest mismatch")
	}
	l, e := ValidateDeletionLedger(payload, control)
	if e != nil {
		return nil, e
	}
	if l.Endpoint != c.Endpoint || l.CapturedAt < c.CapturedNotBefore || l.CapturedAt > at || !safeNonnegative(at) {
		return nil, errors.New("deletion ledger cutoff or endpoint mismatch")
	}
	if _, e = LockDeletionTablesWithin(ctx, tx); e != nil {
		return nil, e
	}
	recovery, e := one(ctx, tx, `SELECT * FROM recovery_state WHERE singleton=true`)
	if e != nil || recovery["status"] != "quarantined" || recovery["recovery_id"] != c.RecoveryID {
		return nil, errors.New("exact quarantined recovery required")
	}
	commandBytes, e := protocol.EncodeJS(c)
	if e != nil {
		return nil, e
	}
	commandHash := identity.Digest(commandBytes)
	prior, e := rows(ctx, tx, `SELECT * FROM deletion_replays WHERE recovery_id=$1 OR id=$2`, c.RecoveryID, c.ID)
	if e != nil {
		return nil, e
	}
	if len(prior) > 0 {
		if len(prior) != 1 || prior[0]["id"] != c.ID || prior[0]["command_hash"] != commandHash {
			return nil, errors.New("recovery already replayed; use its original command or a fresh restore")
		}
		result, ok := prior[0]["result"].(map[string]any)
		if !ok {
			return nil, errors.New("invalid original replay result")
		}
		return result, nil
	}
	existing, e := ledgerRowsWithin(ctx, tx, "")
	if e != nil {
		return nil, e
	}
	sourceEvents := map[string]Object{}
	for _, row := range l.Tables["deletion_events"] {
		sourceEvents[text(row["id"])] = row
	}
	present := map[string]map[string]bool{}
	for _, name := range ledgerNames {
		source := map[string]Object{}
		for _, row := range l.Tables[name] {
			source[text(row["id"])] = row
		}
		present[name] = map[string]bool{}
		for _, row := range existing[name] {
			id := text(row["id"])
			later := source[id]
			present[name][id] = true
			if later == nil {
				return nil, errors.New("source deletion ledger is incomplete or diverges from backup")
			}
			ignored := map[string]bool{}
			if name == "deletion_requests" {
				for _, key := range []string{"state", "revision", "updated_at", "execution_result", "minimized_at"} {
					ignored[key] = true
				}
			}
			if name == "deletion_events" && later["payload_minimized"] == true {
				for _, key := range []string{"payload_text", "payload_minimized", "retained_payload", "retained_hash"} {
					ignored[key] = true
				}
				retained := row["retained_payload"]
				if row["payload_minimized"] != true {
					retained, e = retainedOperatorPayload(row)
					if e != nil {
						return nil, e
					}
				}
				if !ledgerEqual(retained, later["retained_payload"]) {
					return nil, errors.New("minimized event diverges from backup")
				}
			}
			if name == "deletion_executions" && sourceEvents[id]["payload_minimized"] == true {
				ignored["result"] = true
				result, ok := later["result"].(map[string]any)
				if !ok || result["originalResultSha256"] != sourceEvents[id]["payload_hash"] {
					return nil, errors.New("compacted execution hash mismatch")
				}
			}
			for _, key := range ledgerColumns[name] {
				if !ignored[key] && !ledgerEqual(row[key], later[key]) {
					return nil, errors.New("source deletion ledger is incomplete or diverges from backup")
				}
			}
			if name == "deletion_requests" && ledgerInteger(row["revision"]) > ledgerInteger(later["revision"]) {
				return nil, errors.New("source deletion ledger is older than backup")
			}
		}
	}
	// Reconstruct existing state before inserting another formerly active request,
	// preserving the original active-request uniqueness and exact ledger IDs.
	for _, row := range l.Tables["deletion_requests"] {
		if present["deletion_requests"][text(row["id"])] {
			value, e := encoded(row["execution_result"])
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `UPDATE deletion_requests SET state=$2,revision=$3,updated_at=$4,execution_result=$5::jsonb,minimized_at=$6 WHERE id=$1`, row["id"], row["state"], int32(ledgerInteger(row["revision"])), ledgerTime(row["updated_at"]), string(value), ledgerTime(row["minimized_at"])); e != nil {
				return nil, e
			}
		}
	}
	for _, row := range l.Tables["deletion_events"] {
		if present["deletion_events"][text(row["id"])] && row["payload_minimized"] == true {
			value, e := encoded(row["retained_payload"])
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `UPDATE deletion_events SET payload_text='',payload_minimized=true,retained_payload=$2::jsonb,retained_hash=$3 WHERE id=$1`, row["id"], string(value), row["retained_hash"]); e != nil {
				return nil, e
			}
		}
	}
	for _, row := range l.Tables["deletion_executions"] {
		if present["deletion_executions"][text(row["id"])] && sourceEvents[text(row["id"])]["payload_minimized"] == true {
			value, e := encoded(row["result"])
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, `UPDATE deletion_executions SET result=$2::jsonb WHERE id=$1`, row["id"], string(value)); e != nil {
				return nil, e
			}
		}
	}
	for _, name := range ledgerNames {
		for _, row := range l.Tables[name] {
			if present[name][text(row["id"])] {
				continue
			}
			fields := ledgerColumns[name]
			args := []any{}
			slots := []string{}
			for i, key := range fields {
				value := row[key]
				if contains([]string{"created_at", "updated_at", "minimized_at"}, key) {
					value = ledgerTime(value)
				}
				slot := "$" + decimalLedger(i+1)
				if contains([]string{"execution_result", "result", "retained_payload", "signer_control_chain"}, key) {
					slot += "::jsonb"
					if value != nil {
						raw, e := encoded(value)
						if e != nil {
							return nil, e
						}
						value = string(raw)
					}
				}
				if key == "revision" {
					value = int32(integer(value))
				}
				args = append(args, value)
				slots = append(slots, slot)
			}
			if _, e = tx.Exec(ctx, "INSERT INTO "+name+"("+strings.Join(fields, ",")+") VALUES("+strings.Join(slots, ",")+")", args...); e != nil {
				return nil, e
			}
		}
	}
	targets := []Object{}
	for _, request := range l.Tables["deletion_requests"] {
		if request["execution_result"] != nil {
			targets = append(targets, request)
		}
	}
	results := []any{}
	for pass := 0; pass <= len(targets); pass++ {
		removed := int64(0)
		for _, request := range targets {
			current, e := one(ctx, tx, `SELECT state,revision FROM deletion_requests WHERE id=$1`, request["id"])
			if e != nil {
				return nil, e
			}
			if pass > 0 && current["state"] != "partial" {
				continue
			}
			execution, ok := request["execution_result"].(map[string]any)
			if !ok {
				return nil, errors.New("invalid source execution receipt")
			}
			// New UUIDs here are only the original explicit restored-copy DB passes,
			// not retries of an issued or unknown external erasure operation.
			result, e := ExecuteWithin(ctx, tx, ExecutionCommand{Version: 1, ID: uuid.NewString(), RequestID: text(request["id"]), ApprovalID: text(execution["approvalId"]), Endpoint: c.Endpoint, ExpectedRevision: integer(current["revision"]), ExecutorRef: c.ExecutorRef}, at, ExecutionOptions{Product: product, RecoveryContext: Object{"recoveryId": c.RecoveryID, "ledgerSha256": c.LedgerSHA256, "sourceCapturedAt": l.CapturedAt}})
			if e != nil {
				return nil, e
			}
			results = append(results, Object{"requestId": request["id"], "executionId": result["id"], "state": result["state"], "deletedCounts": result["deletedCounts"], "remainingCounts": result["remainingCounts"]})
			if counts, ok := result["deletedCounts"].(map[string]any); ok {
				for _, n := range counts {
					removed += integer(n)
				}
			}
		}
		if removed == 0 {
			break
		}
	}
	result := Object{"version": 1, "id": c.ID, "recoveryId": c.RecoveryID, "endpoint": c.Endpoint, "ledgerSha256": c.LedgerSHA256, "sourceCapturedAt": l.CapturedAt, "replayedAt": at, "requestsImported": len(l.Tables["deletion_requests"]), "requestsReplayed": len(targets), "executionsReplayed": len(results), "results": results, "quarantined": true, "publicActivationReady": false, "sourceFreshness": "at-explicit-capture-cutoff-only", "serviceWideDeletionComplete": false}
	resultRaw, e := encoded(result)
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO deletion_replays(id,recovery_id,source_digest,command_hash,result) VALUES($1,$2,$3,$4,$5::jsonb)`, c.ID, c.RecoveryID, c.LedgerSHA256, commandHash, string(resultRaw)); e != nil {
		return nil, e
	}
	return result, nil
}
