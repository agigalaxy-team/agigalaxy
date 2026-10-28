package subjectlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	whatwg "github.com/nlnwa/whatwg-url/url"
)

const ledgerLimit = 20 * 1024 * 1024

var ledgerNames = []string{"deletion_requests", "deletion_events", "deletion_executions"}
var ledgerColumns = map[string][]string{
	"deletion_requests":   {"id", "subject_id", "binding_id", "requester_public_key", "payload_text", "payload_hash", "signature", "state", "revision", "created_at", "updated_at", "execution_result", "minimized_at"},
	"deletion_events":     {"id", "request_id", "revision", "actor_kind", "actor_ref", "kind", "payload_text", "payload_hash", "signature", "created_at", "payload_minimized", "retained_payload", "retained_hash", "signer_public_key", "signer_control_chain"},
	"deletion_executions": {"id", "request_id", "subject_id", "command_hash", "result", "created_at"},
}

type DeletionLedger struct {
	Version    int                 `json:"version"`
	Schema     int                 `json:"schema"`
	Endpoint   string              `json:"endpoint"`
	CapturedAt int64               `json:"capturedAt"`
	Tables     map[string][]Object `json:"tables"`
}

// HistoricalControlVerifier verifies the original historical chain bytes. A
// current session/key lookup cannot replace it. No chain-bearing artifact is
// accepted without the real historical verifier (nil selects the owning one).
type HistoricalControlDevice struct {
	PublicKey string
	Scopes    []string
}
type HistoricalControl struct {
	SubjectID string
	Devices   []HistoricalControlDevice
}
type HistoricalControlVerifier func([]byte) (HistoricalControl, error)

func VerifyHistoricalControl(raw []byte) (HistoricalControl, error) {
	verified, e := identity.VerifyControlChain(raw)
	if e != nil {
		return HistoricalControl{}, e
	}
	result := HistoricalControl{SubjectID: verified.SubjectID, Devices: []HistoricalControlDevice{}}
	for _, device := range verified.Devices {
		result.Devices = append(result.Devices, HistoricalControlDevice{PublicKey: device.PublicKey, Scopes: device.Scopes})
	}
	return result, nil
}

func ledgerOrigin(endpoint string) bool {
	u, e := whatwg.Parse(endpoint)
	return e == nil && u.Protocol() == "https:" && endpoint == "https://"+u.Host()
}
func ledgerEqual(a, b any) bool {
	x, e := protocol.EncodeJS(a)
	if e != nil {
		return false
	}
	y, e := protocol.EncodeJS(b)
	return e == nil && string(x) == string(y)
}
func ledgerInteger(v any) int64 {
	if number, ok := v.(json.Number); ok {
		n, e := number.Float64()
		if e == nil {
			return int64(n)
		}
	}
	return integer(v)
}
func ledgerIntent(row Object, key, endpoint, subject string) (deletionIntent, error) {
	raw, e := openSigned(text(row["signature"]), key, "galaxy-deletion-intent+jws")
	if e != nil || string(raw) != text(row["payload_text"]) || identity.Digest(raw) != row["payload_hash"] {
		return deletionIntent{}, errors.New("deletion ledger signature mismatch")
	}
	v, e := parseIntent(raw, false)
	if e != nil || v.SubjectID != subject || v.Endpoint != endpoint || v.ID != row["id"] {
		return v, errors.New("deletion ledger identity mismatch")
	}
	return v, nil
}

// ValidateDeletionLedger checks the entire original request/event/execution
// graph, exact signatures and original approval transitions before restoration
// or receipt minimization can consume it. It does not query current credentials.
func ValidateDeletionLedger(raw []byte, control HistoricalControlVerifier) (DeletionLedger, error) {
	var l DeletionLedger
	bad := func() (DeletionLedger, error) { return l, errors.New("invalid deletion ledger") }
	if !requiredFields(raw, "version", "schema", "endpoint", "capturedAt", "tables") || len(raw) > ledgerLimit || protocol.Decode(raw, &l) != nil || l.Version != 1 || l.Schema != maintenanceCatalog.Versions[len(maintenanceCatalog.Versions)-1] || !ledgerOrigin(l.Endpoint) || l.CapturedAt < 0 || l.CapturedAt > 9007199254740991 || len(l.Tables) != 3 {
		return bad()
	}
	if control == nil {
		control = VerifyHistoricalControl
	}
	for _, name := range ledgerNames {
		list, exists := l.Tables[name]
		if !exists || list == nil || len(list) > 100000 {
			return bad()
		}
		seen := map[string]bool{}
		for _, row := range list {
			if !validID(text(row["id"])) || seen[text(row["id"])] || len(row) != len(ledgerColumns[name]) {
				return bad()
			}
			seen[text(row["id"])] = true
			for _, key := range ledgerColumns[name] {
				if _, ok := row[key]; !ok {
					return bad()
				}
			}
		}
	}
	events := map[string][]Object{}
	executions := map[string]Object{}
	for _, row := range l.Tables["deletion_events"] {
		key := text(row["request_id"])
		events[key] = append(events[key], row)
	}
	for _, row := range l.Tables["deletion_executions"] {
		executions[text(row["id"])] = row
	}
	executionCount := 0
	for _, request := range l.Tables["deletion_requests"] {
		original, e := ledgerIntent(request, text(request["requester_public_key"]), l.Endpoint, text(request["subject_id"]))
		if e != nil {
			return l, e
		}
		if original.Action != "request" || original.BindingID != request["binding_id"] {
			return bad()
		}
		history := events[text(request["id"])]
		delete(events, text(request["id"]))
		sort.Slice(history, func(i, j int) bool {
			return ledgerInteger(history[i]["revision"]) < ledgerInteger(history[j]["revision"])
		})
		state := ""
		var last any
		approvals := map[string]bool{}
		for index, event := range history {
			// JSON revisions must be numbers, not numeric strings supplied by an artifact.
			revision, ok := event["revision"].(json.Number)
			number, numberError := revision.Float64()
			if !ok || numberError != nil || number != float64(index+1) {
				return bad()
			}
			payload, e := deletionEventPayload(event)
			if e != nil {
				return l, e
			}
			if event["actor_kind"] == "subject" {
				key := text(request["requester_public_key"])
				if event["signer_control_chain"] != nil {
					chainRaw, e := protocol.EncodeJS(event["signer_control_chain"])
					if e != nil {
						return l, e
					}
					verified, e := control(chainRaw)
					if e != nil {
						return l, e
					}
					matched := false
					for _, device := range verified.Devices {
						if device.PublicKey == event["signer_public_key"] && (contains(device.Scopes, "*") || contains(device.Scopes, "data-delete")) {
							matched = true
						}
					}
					if verified.SubjectID != request["subject_id"] || !matched {
						return bad()
					}
					key = text(event["signer_public_key"])
				} else if event["signer_public_key"] != nil && event["signer_public_key"] != request["requester_public_key"] {
					return bad()
				}
				intent, e := ledgerIntent(event, key, l.Endpoint, text(request["subject_id"]))
				if e != nil {
					return l, e
				}
				if event["actor_ref"] != request["subject_id"] || intent.Action != event["kind"] {
					return bad()
				}
				if event["kind"] == "request" {
					if index != 0 || event["id"] != request["id"] || event["signature"] != request["signature"] || event["payload_text"] != request["payload_text"] {
						return bad()
					}
					state = "requested"
				} else {
					if !contains([]string{"requested", "review-needed", "approved"}, state) || intent.RequestID != request["id"] || intent.ExpectedRevision != int64(index) {
						return bad()
					}
					state = "cancelled"
				}
			} else if event["actor_kind"] == "operator" && event["signature"] == nil {
				switch event["kind"] {
				case "minimize":
					v, e := parseMinimizationEvent(payload)
					if e != nil {
						return l, e
					}
					if !contains([]string{"cancelled", "rejected", "primary-erased"}, state) || v.ID != event["id"] || v.RequestID != request["id"] || v.Endpoint != l.Endpoint || v.ExpectedRevision != int64(index) || v.OperatorRef != event["actor_ref"] {
						return bad()
					}
				case "execute":
					var v Object
					if json.Unmarshal(payload, &v) != nil {
						return bad()
					}
					execution := executions[text(event["id"])]
					if !contains([]string{"approved", "partial", "primary-erased"}, state) || execution == nil || execution["request_id"] != request["id"] || execution["subject_id"] != request["subject_id"] || !ledgerEqual(execution["result"], v) || !approvals[text(v["approvalId"])] || v["id"] != event["id"] || v["requestId"] != request["id"] || v["subjectId"] != request["subject_id"] || v["endpoint"] != l.Endpoint || !ledgerEqual(v["revision"], event["revision"]) || !contains([]string{"partial", "primary-erased"}, text(v["state"])) || !hashPattern.MatchString(text(execution["command_hash"])) || event["payload_minimized"] == true && v["originalResultSha256"] != event["payload_hash"] {
						return bad()
					}
					state = text(v["state"])
					last = v
					executionCount++
				default:
					v, e := parseReview(payload)
					if e != nil {
						return l, e
					}
					if !contains([]string{"requested", "review-needed"}, state) || v.ID != event["id"] || v.RequestID != request["id"] || v.Endpoint != l.Endpoint || v.ExpectedRevision != int64(index) || v.ReviewerRef != event["actor_ref"] || v.Decision != event["kind"] {
						return bad()
					}
					state = map[string]string{"needs-information": "review-needed", "approve": "approved", "reject": "rejected"}[v.Decision]
					if state == "approved" {
						approvals[v.ID] = true
					}
				}
			} else {
				return bad()
			}
		}
		if len(history) == 0 || !ledgerEqual(request["revision"], len(history)) || request["state"] != state || !ledgerEqual(request["execution_result"], last) {
			return bad()
		}
	}
	if len(events) > 0 || executionCount != len(executions) {
		return bad()
	}
	return l, nil
}

func ledgerRowsWithin(ctx context.Context, tx pgx.Tx, requestID string) (map[string][]Object, error) {
	tables := map[string][]Object{}
	for _, name := range ledgerNames {
		q := "SELECT " + strings.Join(ledgerColumns[name], ",") + " FROM " + name
		args := []any{}
		if requestID != "" {
			key := "request_id"
			if name == "deletion_requests" {
				key = "id"
			}
			q += " WHERE " + key + "=$1"
			args = append(args, requestID)
		}
		list, e := rows(ctx, tx, q+" ORDER BY id", args...)
		if e != nil {
			return nil, e
		}
		tables[name] = list
	}
	return tables, nil
}

// CaptureDeletionLedgerWithin freezes writers before assigning the cutoff.
// The returned artifact must be kept in an independently protected location by
// the explicit maintenance caller; this function never writes a public file.
func CaptureDeletionLedgerWithin(ctx context.Context, tx pgx.Tx, endpoint string, now func() int64, control HistoricalControlVerifier) (Object, error) {
	if !ledgerOrigin(endpoint) || now == nil {
		return nil, errors.New("invalid deletion ledger capture")
	}
	if _, e := tx.Exec(ctx, `LOCK TABLE deletion_events,deletion_executions,deletion_requests,schema_migrations IN SHARE MODE`); e != nil {
		return nil, e
	}
	versions, e := rows(ctx, tx, `SELECT version FROM schema_migrations ORDER BY version`)
	if e != nil {
		return nil, e
	}
	if len(versions) != len(maintenanceCatalog.Versions) {
		return nil, errors.New("deletion ledger schema mismatch")
	}
	for i, v := range versions {
		if integer(v["version"]) != int64(maintenanceCatalog.Versions[i]) {
			return nil, errors.New("deletion ledger schema mismatch")
		}
	}
	total := int64(0)
	for _, name := range ledgerNames {
		size, e := one(ctx, tx, `SELECT count(*) AS count,COALESCE(sum(octet_length(to_jsonb(t)::text)),0) AS bytes FROM `+name+` t`)
		if e != nil {
			return nil, e
		}
		total += integer(size["bytes"])
		if total > ledgerLimit/2 || integer(size["count"]) > 100000 {
			return nil, errors.New("deletion ledger exceeds capture limit")
		}
	}
	tables, e := ledgerRowsWithin(ctx, tx, "")
	if e != nil {
		return nil, e
	}
	ledger := DeletionLedger{Version: 1, Schema: maintenanceCatalog.Versions[len(maintenanceCatalog.Versions)-1], Endpoint: endpoint, CapturedAt: now(), Tables: tables}
	// Restore original SELECT-column insertion order, including JSONB's retained
	// object order for nested values, before assigning this artifact's digest.
	wireTables := protocol.NewOrderedObject()
	for _, name := range ledgerNames {
		// PostgreSQL jsonb::text has an observable member order in the original
		// driver. Decode those columns as ordered values for artifact bytes.
		fields := []string{}
		for _, key := range ledgerColumns[name] {
			if contains([]string{"execution_result", "result", "retained_payload", "signer_control_chain"}, key) {
				fields = append(fields, key+"::text AS "+key)
			} else {
				fields = append(fields, key)
			}
		}
		wireRows, e := rows(ctx, tx, "SELECT "+strings.Join(fields, ",")+" FROM "+name+" ORDER BY id")
		if e != nil {
			return nil, e
		}
		list := []any{}
		for _, row := range wireRows {
			o := protocol.NewOrderedObject()
			for _, key := range ledgerColumns[name] {
				value := row[key]
				if value != nil && contains([]string{"execution_result", "result", "retained_payload", "signer_control_chain"}, key) {
					value, e = protocol.DecodeOrdered([]byte(text(value)))
					if e != nil {
						return nil, e
					}
				}
				o.Set(key, value)
			}
			list = append(list, o)
		}
		wireTables.Set(name, list)
	}
	wire := protocol.NewOrderedObject()
	wire.Set("version", 1)
	wire.Set("schema", ledger.Schema)
	wire.Set("endpoint", endpoint)
	wire.Set("capturedAt", ledger.CapturedAt)
	wire.Set("tables", wireTables)
	raw, e := protocol.EncodeJS(wire)
	if e != nil {
		return nil, e
	}
	if _, e = ValidateDeletionLedger(raw, control); e != nil {
		return nil, e
	}
	return Object{"payloadJson": string(raw), "sha256": identity.Digest(raw), "capturedAt": ledger.CapturedAt, "bytes": len(raw), "requests": len(tables["deletion_requests"])}, nil
}
