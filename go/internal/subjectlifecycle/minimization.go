package subjectlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	whatwg "github.com/nlnwa/whatwg-url/url"
)

type MinimizationPolicy struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	NotBefore int64  `json:"notBefore"`
	Basis     string `json:"basis"`
}
type MinimizationCommand struct {
	Version          int                `json:"version"`
	ID               string             `json:"id"`
	RequestID        string             `json:"requestId"`
	Endpoint         string             `json:"endpoint"`
	ExpectedRevision int64              `json:"expectedRevision"`
	OperatorRef      string             `json:"operatorRef"`
	Policy           MinimizationPolicy `json:"policy"`
}
type MinimizationEvent struct {
	Version          int    `json:"version"`
	ID               string `json:"id"`
	RequestID        string `json:"requestId"`
	Endpoint         string `json:"endpoint"`
	ExpectedRevision int64  `json:"expectedRevision"`
	OperatorRef      string `json:"operatorRef"`
	Policy           struct {
		ID        string `json:"id"`
		Version   string `json:"version"`
		NotBefore int64  `json:"notBefore"`
		BasisHash string `json:"basisHash"`
	} `json:"policy"`
	CommandHash               string `json:"commandHash"`
	At                        int64  `json:"at"`
	EventsMinimized           int64  `json:"eventsMinimized"`
	ExecutionResultsCompacted int64  `json:"executionResultsCompacted"`
	PayloadBytesRemoved       int64  `json:"payloadBytesRemoved"`
}

func safeNonnegative(v int64) bool { return v >= 0 && v <= 9007199254740991 }
func validMinimizationCommon(version int, id, request, endpoint string, revision int64, operator string) bool {
	_, e := whatwg.Parse(endpoint)
	return version == 1 && validID(id) && validID(request) && e == nil && revision > 0 && safeNonnegative(revision) && operatorRef.MatchString(operator)
}
func parseMinimizationEvent(raw []byte) (MinimizationEvent, error) {
	var v MinimizationEvent
	if !minimizationShape(raw, true) || protocol.Decode(raw, &v) != nil || !validMinimizationCommon(v.Version, v.ID, v.RequestID, v.Endpoint, v.ExpectedRevision, v.OperatorRef) || !validBasis(v.Policy.ID, 100) || !validBasis(v.Policy.Version, 80) || !safeNonnegative(v.Policy.NotBefore) || !hashPattern.MatchString(v.Policy.BasisHash) || !hashPattern.MatchString(v.CommandHash) || !safeNonnegative(v.At) || !safeNonnegative(v.EventsMinimized) || !safeNonnegative(v.ExecutionResultsCompacted) || !safeNonnegative(v.PayloadBytesRemoved) {
		return v, errors.New("invalid deletion minimization event")
	}
	return v, nil
}
func parseMinimization(raw []byte) (MinimizationCommand, error) {
	var c MinimizationCommand
	if !minimizationShape(raw, false) || protocol.Decode(raw, &c) != nil || !validMinimizationCommon(c.Version, c.ID, c.RequestID, c.Endpoint, c.ExpectedRevision, c.OperatorRef) || !validBasis(c.Policy.ID, 100) || !validBasis(c.Policy.Version, 80) || !safeNonnegative(c.Policy.NotBefore) || !validBasis(c.Policy.Basis, 2000) {
		return c, errors.New("invalid deletion minimization")
	}
	return c, nil
}
func retainedOperatorPayload(event Object) (Object, error) {
	raw, e := deletionEventPayload(event)
	if e != nil {
		return nil, e
	}
	if event["kind"] != "execute" {
		v, e := parseReview(raw)
		if e != nil {
			return nil, e
		}
		v.Explanation = "sha256:" + identity.Digest([]byte(v.Explanation))
		if v.Plan != nil {
			v.Plan.Primary.Basis = "sha256:" + identity.Digest([]byte(v.Plan.Primary.Basis))
			v.Plan.Audit.Basis = "sha256:" + identity.Digest([]byte(v.Plan.Audit.Basis))
			v.Plan.Backups.Basis = "sha256:" + identity.Digest([]byte(v.Plan.Backups.Basis))
		}
		raw, e = protocol.EncodeJS(v)
		if e != nil {
			return nil, e
		}
	}
	var value Object
	if json.Unmarshal(raw, &value) != nil {
		return nil, errors.New("invalid retained operator payload")
	}
	if event["kind"] != "execute" {
		return value, nil
	}
	delete(value, "selectedCounts")
	delete(value, "revoked")
	delete(value, "passes")
	nonzero := func(v any) Object {
		o := Object{}
		if m, ok := v.(map[string]any); ok {
			for k, n := range m {
				if n != float64(0) {
					o[k] = n
				}
			}
		}
		return o
	}
	for _, key := range []string{"deletedCounts", "totalDeletedCounts", "remainingCounts"} {
		value[key] = nonzero(value[key])
	}
	for _, key := range []string{"primary", "audit"} {
		if part, ok := value[key].(map[string]any); ok {
			part["remaining"] = nonzero(part["remaining"])
		}
	}
	value["minimized"] = true
	value["originalResultSha256"] = event["payload_hash"]
	value["receiptLedger"] = Object{"state": "minimized", "cleanupImplemented": true, "scope": "operator-text-and-execution-detail", "originalSignedIntentsRetained": true}
	return value, nil
}

// MinimizeDeletionReceiptWithin preserves the exact signed user intents while
// compacting only due terminal operator text under the original approved audit
// and backup deadlines. It never marks backup media as erased.
func MinimizeDeletionReceiptWithin(ctx context.Context, tx pgx.Tx, raw []byte, at int64, control HistoricalControlVerifier) (Object, error) {
	c, e := parseMinimization(raw)
	if e != nil {
		return nil, e
	}
	commandRaw, e := protocol.EncodeJS(c)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest(commandRaw)
	if _, e = LockDeletionTablesWithin(ctx, tx); e != nil {
		return nil, e
	}
	row, e := one(ctx, tx, `SELECT * FROM deletion_requests WHERE id=$1`, c.RequestID)
	if e != nil {
		return nil, e
	}
	var intent Object
	if json.Unmarshal([]byte(text(row["payload_text"])), &intent) != nil || intent["endpoint"] != c.Endpoint {
		return nil, errors.New("minimization target mismatch")
	}
	prior, e := one(ctx, tx, `SELECT * FROM deletion_events WHERE id=$1`, c.ID)
	if e == nil {
		payload, e := deletionEventPayload(prior)
		if e != nil {
			return nil, e
		}
		var v Object
		_ = json.Unmarshal(payload, &v)
		if prior["kind"] != "minimize" || prior["request_id"] != row["id"] || v["commandHash"] != hash {
			return nil, errors.New("minimization ID conflict")
		}
		receipt := deletionReceipt(row, c.Endpoint)
		receipt["minimization"] = v
		return receipt, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	if integer(row["revision"]) != c.ExpectedRevision || !contains([]string{"cancelled", "rejected", "primary-erased"}, text(row["state"])) {
		return nil, errors.New("minimization request is not terminal or changed")
	}
	if execution, ok := row["execution_result"].(map[string]any); ok {
		if remaining, ok := execution["remainingCounts"].(map[string]any); ok {
			for _, n := range remaining {
				if integer(n) != 0 {
					return nil, errors.New("retained data must be resolved before minimization")
				}
			}
		}
	}
	tables, e := ledgerRowsWithin(ctx, tx, c.RequestID)
	if e != nil {
		return nil, e
	}
	ledgerRaw, e := protocol.EncodeJS(DeletionLedger{Version: 1, Schema: maintenanceCatalog.Versions[len(maintenanceCatalog.Versions)-1], Endpoint: c.Endpoint, CapturedAt: at, Tables: tables})
	if e != nil {
		return nil, e
	}
	if _, e = ValidateDeletionLedger(ledgerRaw, control); e != nil {
		return nil, e
	}
	until := c.Policy.NotBefore
	for _, event := range tables["deletion_events"] {
		if event["kind"] == "approve" {
			payload, e := deletionEventPayload(event)
			if e != nil {
				return nil, e
			}
			review, e := parseReview(payload)
			if e != nil {
				return nil, e
			}
			until = max(until, review.Plan.Audit.Until, review.Plan.Backups.Until)
		}
	}
	if !safeNonnegative(at) || at < until {
		return nil, errors.New("receipt minimization is not due")
	}
	v := MinimizationEvent{Version: 1, ID: c.ID, RequestID: c.RequestID, Endpoint: c.Endpoint, ExpectedRevision: c.ExpectedRevision, OperatorRef: c.OperatorRef, CommandHash: hash, At: at}
	v.Policy.ID = c.Policy.ID
	v.Policy.Version = c.Policy.Version
	v.Policy.NotBefore = c.Policy.NotBefore
	v.Policy.BasisHash = identity.Digest([]byte(c.Policy.Basis))
	last := row["execution_result"]
	for _, event := range tables["deletion_events"] {
		if event["actor_kind"] != "operator" || event["kind"] == "minimize" || event["payload_minimized"] == true {
			continue
		}
		retained, e := retainedOperatorPayload(event)
		if e != nil {
			return nil, e
		}
		payload, e := encoded(retained)
		if e != nil {
			return nil, e
		}
		if event["kind"] == "execute" {
			v.ExecutionResultsCompacted++
			if _, e = tx.Exec(ctx, `UPDATE deletion_executions SET result=$2::jsonb WHERE id=$1`, event["id"], string(payload)); e != nil {
				return nil, e
			}
			if execution, ok := last.(map[string]any); ok && execution["id"] == event["id"] {
				last = retained
			}
		}
		if _, e = tx.Exec(ctx, `UPDATE deletion_events SET payload_text='',payload_minimized=true,retained_payload=$2::jsonb,retained_hash=$3 WHERE id=$1`, event["id"], string(payload), identity.Digest(payload)); e != nil {
			return nil, e
		}
		v.EventsMinimized++
		v.PayloadBytesRemoved += int64(len(text(event["payload_text"])))
	}
	payload, e := protocol.EncodeJS(v)
	if e != nil {
		return nil, e
	}
	lastRaw, e := encoded(last)
	if e != nil {
		return nil, e
	}
	updated, e := one(ctx, tx, `UPDATE deletion_requests SET revision=revision+1,execution_result=$2::jsonb,minimized_at=$3,updated_at=$3 WHERE id=$1 RETURNING *`, row["id"], string(lastRaw), time.Unix(at, 0))
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO deletion_events(id,request_id,revision,actor_kind,actor_ref,kind,payload_text,payload_hash) VALUES($1,$2,$3,'operator',$4,'minimize',$5,$6)`, c.ID, row["id"], updated["revision"], c.OperatorRef, string(payload), identity.Digest(payload)); e != nil {
		return nil, e
	}
	result := deletionReceipt(updated, c.Endpoint)
	result["minimization"] = v
	return result, nil
}

func minimizationShape(raw []byte, event bool) bool {
	keys := []string{"version", "id", "requestId", "endpoint", "expectedRevision", "operatorRef", "policy"}
	policyKeys := []string{"id", "version", "notBefore", "basis"}
	if event {
		keys = append(keys, "commandHash", "at", "eventsMinimized", "executionResultsCompacted", "payloadBytesRemoved")
		policyKeys[3] = "basisHash"
	}
	if !requiredFields(raw, keys...) {
		return false
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	return requiredFields(fields["policy"], policyKeys...)
}
