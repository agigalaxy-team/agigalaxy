package subjectlifecycle

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// The original closed maintenance inventory is separate from the export
// catalog: owner takeout columns do not define physical deletion authority.
//
//go:embed maintenance_catalog.json
var maintenanceData []byte
var maintenanceCatalog struct {
	Targets                                       map[string]string
	Excluded, ControlHistory, ChatDelegatedTables []string
	Versions                                      []int
}

func init() {
	if e := json.Unmarshal(maintenanceData, &maintenanceCatalog); e != nil {
		panic(e)
	}
}

type PrimaryKey struct {
	Name   string `json:"name"`
	Column string `json:"column"`
	Type   string `json:"type"`
	Order  int64  `json:"ord"`
}
type ForeignColumn struct{ Source, Target string }
type ForeignReference struct {
	Target, Source, SourceSchema, Action, ConstraintID string
	Columns                                            []ForeignColumn
}
type DeletionInventory struct {
	Tables     []string
	Keys       map[string][]PrimaryKey
	References []ForeignReference
}

var identifier = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

func quote(value string) (string, error) {
	if !identifier.MatchString(value) {
		return "", errors.New("unsupported database identifier")
	}
	return `"` + value + `"`, nil
}

// LockDeletionTablesWithin reproduces the original closed schema inventory and
// maintenance lock. Call only on the explicit maintenance connection, after
// stopping/draining ordinary traffic; the transaction owns every lock.
func LockDeletionTablesWithin(ctx context.Context, tx pgx.Tx) (DeletionInventory, error) {
	inventory := DeletionInventory{Keys: map[string][]PrimaryKey{}}
	var actual []int
	r, e := tx.Query(ctx, "SELECT version FROM schema_migrations ORDER BY version")
	if e != nil {
		return inventory, e
	}
	for r.Next() {
		var v int
		if e = r.Scan(&v); e != nil {
			r.Close()
			return inventory, e
		}
		actual = append(actual, v)
	}
	e = r.Err()
	r.Close()
	if e != nil {
		return inventory, e
	}
	if !slices.Equal(actual, maintenanceCatalog.Versions) {
		return inventory, errors.New("migrations required")
	}
	tableRows, e := rows(ctx, tx, "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
	if e != nil {
		return inventory, e
	}
	mandatory := append([]string{}, maintenanceCatalog.Excluded...)
	for name := range maintenanceCatalog.Targets {
		mandatory = append(mandatory, name)
	}
	known := append(append([]string{}, mandatory...), maintenanceCatalog.ChatDelegatedTables...)
	lockNames := []string{}
	for _, row := range tableRows {
		name := text(row["tablename"])
		if !slices.Contains(known, name) {
			return inventory, errors.New("deletion inventory does not cover this database schema")
		}
		q, e := quote(name)
		if e != nil {
			return inventory, e
		}
		lockNames = append(lockNames, "public."+q)
		inventory.Tables = append(inventory.Tables, name)
	}
	for _, name := range mandatory {
		if !slices.Contains(inventory.Tables, name) {
			return inventory, errors.New("deletion inventory does not cover this database schema")
		}
	}
	if _, e = tx.Exec(ctx, "LOCK TABLE "+strings.Join(lockNames, ",")+" IN ACCESS EXCLUSIVE MODE"); e != nil {
		return inventory, e
	}
	keys, e := rows(ctx, tx, `SELECT r.relname AS name,a.attname AS column,format_type(a.atttypid,a.atttypmod) AS type,k.ord FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=k.num WHERE c.contype='p' AND n.nspname='public' ORDER BY r.relname,k.ord`)
	if e != nil {
		return inventory, e
	}
	for _, key := range keys {
		name := text(key["name"])
		if _, ok := maintenanceCatalog.Targets[name]; !ok {
			continue
		}
		kind := text(key["type"])
		if !contains([]string{"uuid", "text", "bigint", "integer", "date"}, kind) {
			return inventory, errors.New("unsupported deletion primary key")
		}
		inventory.Keys[name] = append(inventory.Keys[name], PrimaryKey{name, text(key["column"]), kind, integer(key["ord"])})
	}
	references, e := rows(ctx, tx, `SELECT target.relname AS target,source.relname AS source,ns.nspname AS source_schema,c.confdeltype AS action,sa.attname AS source_column,ta.attname AS target_column,c.oid::text AS constraint_id,k.ord FROM pg_constraint c JOIN pg_class target ON target.oid=c.confrelid JOIN pg_namespace nt ON nt.oid=target.relnamespace JOIN pg_class source ON source.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=source.relnamespace CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(src,dst,ord) JOIN pg_attribute sa ON sa.attrelid=source.oid AND sa.attnum=k.src JOIN pg_attribute ta ON ta.attrelid=target.oid AND ta.attnum=k.dst WHERE c.contype='f' AND nt.nspname='public' ORDER BY c.oid,k.ord`)
	if e != nil {
		return inventory, e
	}
	index := map[string]int{}
	for _, row := range references {
		if text(row["source_schema"]) != "public" {
			return inventory, errors.New("external schema reference needs its own deletion plan")
		}
		id := text(row["constraint_id"])
		i, ok := index[id]
		if !ok {
			i = len(inventory.References)
			index[id] = i
			inventory.References = append(inventory.References, ForeignReference{Target: text(row["target"]), Source: text(row["source"]), SourceSchema: text(row["source_schema"]), Action: text(row["action"]), ConstraintID: id})
		}
		inventory.References[i].Columns = append(inventory.References[i].Columns, ForeignColumn{text(row["source_column"]), text(row["target_column"])})
	}
	return inventory, nil
}

type ExecutionCommand struct {
	Version          int    `json:"version"`
	ID               string `json:"id"`
	RequestID        string `json:"requestId"`
	ApprovalID       string `json:"approvalId"`
	Endpoint         string `json:"endpoint"`
	ExpectedRevision int64  `json:"expectedRevision"`
	ExecutorRef      string `json:"executorRef"`
}
type DeletionPlan struct {
	PolicyID      string `json:"policyId"`
	PolicyVersion string `json:"policyVersion"`
	Primary       struct {
		Action    string `json:"action"`
		NotBefore int64  `json:"notBefore"`
		Basis     string `json:"basis"`
	} `json:"primary"`
	Audit struct {
		Action string `json:"action"`
		Until  int64  `json:"until"`
		Basis  string `json:"basis"`
	} `json:"audit"`
	Backups struct {
		Action string `json:"action"`
		Until  int64  `json:"until"`
		Basis  string `json:"basis"`
	} `json:"backups"`
	ExternalCopies string `json:"externalCopies"`
}
type ExecutionPreparation struct {
	Command     ExecutionCommand
	CommandHash string
	Inventory   DeletionInventory
	Plan        DeletionPlan
	PriorResult Object
	SubjectID   string
	// Request evidence stays in this package; preparation is not an HTTP DTO.
	request Object
}

var operatorRef = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)

func validCommand(c ExecutionCommand) bool {
	return c.Version == 1 && validID(c.ID) && validID(c.RequestID) && validID(c.ApprovalID) && c.ExpectedRevision > 0 && operatorRef.MatchString(c.ExecutorRef) && c.Endpoint != ""
}

// PrepareExecutionWithin verifies the original stored approval and exact signed
// request under the complete maintenance inventory. It performs no revocation,
// source minimization or row deletion. Missing domain consumers keep Execute
// unavailable; preparation alone is never a successful erasure receipt.
func PrepareExecutionWithin(ctx context.Context, tx pgx.Tx, c ExecutionCommand, at int64) (ExecutionPreparation, error) {
	p := ExecutionPreparation{Command: c}
	if !validCommand(c) {
		return p, errors.New("invalid deletion execution command")
	}
	raw, e := encoded(c)
	if e != nil {
		return p, e
	}
	p.CommandHash = identity.Digest(raw)
	p.Inventory, e = LockDeletionTablesWithin(ctx, tx)
	if e != nil {
		return p, e
	}
	prior, e := one(ctx, tx, "SELECT command_hash,result FROM deletion_executions WHERE id=$1", c.ID)
	if e == nil {
		if text(prior["command_hash"]) != p.CommandHash {
			return p, errors.New("deletion execution ID conflict")
		}
		_ = remarshal(prior["result"], &p.PriorResult)
		return p, nil
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return p, e
	}
	request, e := one(ctx, tx, "SELECT * FROM deletion_requests WHERE id=$1 FOR UPDATE", c.RequestID)
	if e != nil {
		return p, e
	}
	if integer(request["revision"]) != c.ExpectedRevision || !contains([]string{"approved", "partial", "primary-erased"}, text(request["state"])) {
		return p, errors.New("deletion execution target changed")
	}
	approved, e := one(ctx, tx, "SELECT * FROM deletion_events WHERE id=$1 AND request_id=$2 AND kind='approve' AND actor_kind='operator'", c.ApprovalID, c.RequestID)
	if e != nil {
		return p, errors.New("deletion approval unavailable")
	}
	reviewRaw, e := deletionEventPayload(approved)
	if e != nil {
		return p, e
	}
	var review struct {
		Version          int          `json:"version"`
		ID               string       `json:"id"`
		RequestID        string       `json:"requestId"`
		Endpoint         string       `json:"endpoint"`
		ExpectedRevision int64        `json:"expectedRevision"`
		ReviewerRef      string       `json:"reviewerRef"`
		Decision         string       `json:"decision"`
		Explanation      string       `json:"explanation"`
		Plan             DeletionPlan `json:"plan"`
	}
	if !validReviewFields(reviewRaw) || protocol.Decode(reviewRaw, &review) != nil || review.Version != 1 || !validID(review.ID) || !validID(review.RequestID) || review.ExpectedRevision < 1 || !operatorRef.MatchString(review.ReviewerRef) || review.Decision != "approve" || !validBasis(review.Explanation, 2000) {
		return p, errors.New("deletion approval mismatch")
	}
	if review.Endpoint != c.Endpoint || review.RequestID != c.RequestID || !validPlan(review.Plan) {
		return p, errors.New("deletion approval mismatch")
	}
	signedPayload, e := openSigned(text(request["signature"]), text(request["requester_public_key"]), "galaxy-deletion-intent+jws")
	if e != nil || string(signedPayload) != text(request["payload_text"]) || identity.Digest(signedPayload) != text(request["payload_hash"]) {
		return p, errors.New("deletion request evidence mismatch")
	}
	intent, e := parseIntent(signedPayload, false)
	if e != nil || intent.Action != "request" || intent.ID != c.RequestID || intent.SubjectID != text(request["subject_id"]) || intent.Endpoint != c.Endpoint {
		return p, errors.New("deletion request evidence mismatch")
	}
	if at < 0 || at < review.Plan.Primary.NotBefore {
		return p, errors.New("deletion execution not due")
	}
	p.Plan = review.Plan
	p.SubjectID = text(request["subject_id"])
	p.request = request
	return p, nil
}
func validBasis(value string, max int) bool {
	return utf8.RuneCountInString(value) > 0 && utf8.RuneCountInString(value) <= max
}
func validPlan(p DeletionPlan) bool {
	return validBasis(p.PolicyID, 100) && validBasis(p.PolicyVersion, 80) && p.Primary.Action == "delete-owned-data" && p.Primary.NotBefore >= 0 && p.Primary.NotBefore <= 9007199254740991 && validBasis(p.Primary.Basis, 2000) && p.Audit.Action == "retain-minimum" && p.Audit.Until >= p.Primary.NotBefore && p.Audit.Until <= 9007199254740991 && validBasis(p.Audit.Basis, 2000) && p.Backups.Action == "expire-snapshots-and-replay-deletions" && p.Backups.Until >= p.Primary.NotBefore && p.Backups.Until <= 9007199254740991 && validBasis(p.Backups.Basis, 2000) && p.ExternalCopies == "outside-service-control"
}
func deletionEventPayload(event Object) ([]byte, error) {
	hash := text(event["payload_hash"])
	if !hashPattern.MatchString(hash) {
		return nil, errors.New("deletion event hash missing")
	}
	if minimized, _ := event["payload_minimized"].(bool); minimized {
		if text(event["actor_kind"]) != "operator" || event["signature"] != nil || text(event["payload_text"]) != "" || !contains([]string{"approve", "reject", "needs-information", "execute"}, text(event["kind"])) || event["retained_payload"] == nil {
			return nil, errors.New("minimized deletion event mismatch")
		}
		raw, e := encoded(event["retained_payload"])
		if e != nil || identity.Digest(raw) != text(event["retained_hash"]) {
			return nil, errors.New("minimized deletion event mismatch")
		}
		return raw, nil
	}
	raw := []byte(text(event["payload_text"]))
	if identity.Digest(raw) != hash || !json.Valid(raw) {
		return nil, fmt.Errorf("deletion event hash mismatch")
	}
	return raw, nil
}

func requiredFields(raw []byte, keys ...string) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil || len(m) != len(keys) {
		return false
	}
	for _, key := range keys {
		v, ok := m[key]
		if !ok || string(v) == "null" {
			return false
		}
	}
	return true
}
func validReviewFields(raw []byte) bool {
	if !requiredFields(raw, "version", "id", "requestId", "endpoint", "expectedRevision", "reviewerRef", "decision", "explanation", "plan") {
		return false
	}
	var review map[string]json.RawMessage
	_ = json.Unmarshal(raw, &review)
	if !requiredFields(review["plan"], "policyId", "policyVersion", "primary", "audit", "backups", "externalCopies") {
		return false
	}
	var plan map[string]json.RawMessage
	_ = json.Unmarshal(review["plan"], &plan)
	return requiredFields(plan["primary"], "action", "notBefore", "basis") && requiredFields(plan["audit"], "action", "until", "basis") && requiredFields(plan["backups"], "action", "until", "basis")
}
