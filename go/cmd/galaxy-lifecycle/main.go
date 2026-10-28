// galaxy-lifecycle is the original explicit maintenance command family. It has
// no HTTP listener, timer, normal-account authentication or implicit approval.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/runtimeconfig"
	"github.com/agigalaxy-team/agigalaxy/go/internal/subjectlifecycle"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const help = "galaxy-lifecycle review|execute|minimize <absolute-command.json> <new-absolute-receipt.json>; galaxy-lifecycle ledger capture|replay <absolute-input.json> <new-absolute-output>; galaxy-lifecycle ledger validate <absolute-ledger.json>; inspect the stored original operation before retry"

func readInput(path string, max int64, noSymlink bool) ([]byte, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("absolute input required")
	}
	var info os.FileInfo
	var e error
	if noSymlink {
		info, e = os.Lstat(path)
	} else {
		info, e = os.Stat(path)
	}
	if e != nil {
		return nil, e
	}
	if !info.Mode().IsRegular() || info.Size() > max {
		return nil, errors.New("invalid maintenance input")
	}
	f, e := os.Open(path)
	if e != nil {
		return nil, e
	}
	defer f.Close()
	raw, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil || int64(len(raw)) > max {
		return nil, errors.New("maintenance input exceeds limit")
	}
	return raw, nil
}
func writeNew(path string, raw []byte) error {
	if !filepath.IsAbs(path) {
		return errors.New("absolute new output required")
	}
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	_, e = f.Write(raw)
	if e == nil {
		e = f.Sync()
	}
	closed := f.Close()
	if e != nil {
		return e
	}
	return closed
}
func writeReceipt(path string, value any) error {
	raw, e := protocol.EncodeJS(value)
	if e != nil {
		return e
	}
	var pretty bytes.Buffer
	if e = json.Indent(&pretty, raw, "", "  "); e != nil {
		return e
	}
	pretty.WriteByte('\n')
	return writeNew(path, pretty.Bytes())
}

// This is the original migration-runtime destination contract. A maintenance
// command cannot borrow API signing configuration or retarget an arbitrary DB.
func maintenanceURL(getenv func(string) string, lookup func(string) (string, bool)) (*url.URL, error) {
	stage := getenv("GALAXY_ENVIRONMENT")
	if stage != "local" && stage != "integration" && stage != "pilot" {
		return nil, errors.New("invalid isolated runtime configuration")
	}
	u, e := url.Parse(getenv("DATABASE_URL"))
	if e != nil || u.Scheme != "postgres" && u.Scheme != "postgresql" || u.Hostname() == "" || u.User == nil || u.User.Username() == "" || u.EscapedPath() != "/galaxy_"+stage || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid isolated runtime configuration")
	}
	for _, name := range []string{"GALAXY_SIGNING_KEY_FILE", "GALAXY_SIGNING_KEY_ID", "GALAXY_ROOT_PINS_FILE", "GALAXY_KEYRING_FILE", "GALAXY_TRUST_DIRECTORY"} {
		if _, present := lookup(name); present {
			return nil, errors.New("API signing configuration is not maintenance authority")
		}
	}
	return u, nil
}
func product(pool *pgxpool.Pool, endpoint string, getenv func(string) string) (*subjectlifecycle.ProductDeletion, error) {
	policy, e := community.LoadForumPolicy(getenv("GALAXY_FORUM_POLICY_FILE"))
	if e != nil {
		return nil, e
	}
	return &subjectlifecycle.ProductDeletion{Forum: &community.Service{Pool: pool, Endpoint: endpoint, Policy: policy}, TaskSnapshots: subjectlifecycle.TaskRedactors{Task: taskmaterials.RedactTaskSnapshot, Participation: taskmaterials.RedactParticipationSnapshot}}, nil
}
func commandJSON(raw []byte) ([]byte, error) {
	value, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	if _, ok := value.(*protocol.OrderedObject); !ok {
		return nil, errors.New("maintenance command object required")
	}
	return protocol.EncodeJS(value)
}

func run(ctx context.Context, args []string, getenv func(string) string, lookup func(string) (string, bool), stdout io.Writer) error {
	if _, err := runtimeconfig.RuntimeServiceRelease(getenv, "lifecycle", ""); err != nil {
		return err
	}
	if len(args) == 1 && (args[0] == "--help" || args[0] == "help") {
		_, e := fmt.Fprintln(stdout, help)
		return e
	}
	if len(args) == 3 && args[0] == "ledger" && args[1] == "validate" {
		raw, e := readInput(args[2], 20*1024*1024, true)
		if e != nil {
			return e
		}
		ledger, e := subjectlifecycle.ValidateDeletionLedger(raw, nil)
		if e != nil {
			return e
		}
		return json.NewEncoder(stdout).Encode(map[string]any{"event": "deletion_ledger_validated", "sha256": identity.Digest(raw), "capturedAt": ledger.CapturedAt, "requests": len(ledger.Tables["deletion_requests"]), "historicalSignaturesVerified": true, "currentRevocationChecked": false})
	}
	mode := ""
	inputPath, outputPath := "", ""
	if len(args) == 3 && (args[0] == "review" || args[0] == "execute" || args[0] == "minimize") {
		mode, inputPath, outputPath = args[0], args[1], args[2]
	} else if len(args) == 4 && args[0] == "ledger" && (args[1] == "capture" || args[1] == "replay") {
		mode, inputPath, outputPath = args[1], args[2], args[3]
	} else {
		return errors.New(help)
	}
	if !filepath.IsAbs(outputPath) {
		return errors.New("absolute new output required")
	}
	maximum := int64(16384)
	if mode == "review" {
		maximum = 65536
	}
	raw, e := readInput(inputPath, maximum, mode != "review" && mode != "execute")
	if e != nil {
		return e
	}
	raw, e = commandJSON(raw)
	if e != nil {
		return e
	}
	connection, e := maintenanceURL(getenv, lookup)
	if e != nil {
		return e
	}
	var replay struct {
		TargetDatabase string `json:"targetDatabase"`
		LedgerPath     string `json:"ledgerPath"`
		subjectlifecycle.ReplayCommand
	}
	if mode == "replay" {
		if protocol.Decode(raw, &replay) != nil || len(replay.TargetDatabase) > 63 || !regexp.MustCompile(`^galaxy_restore_[a-z0-9_]+$`).MatchString(replay.TargetDatabase) {
			return errors.New("invalid restore target")
		}
		connection.Path = "/" + replay.TargetDatabase
		connection.RawPath = ""
	}
	pool, e := postgres.Open(ctx, connection.String())
	if e != nil {
		return fault.New("maintenance_database_unavailable", 503)
	}
	defer pool.Close()
	if mode == "replay" {
		var target string
		if e = pool.QueryRow(ctx, `SELECT current_database()`).Scan(&target); e != nil || target != replay.TargetDatabase {
			return errors.New("restore target mismatch")
		}
	}
	at := time.Now().Unix()
	var result map[string]any
	switch mode {
	case "review":
		result, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (map[string]any, error) { return subjectlifecycle.ReviewDeletionWithin(ctx, tx, raw) })
	case "execute":
		var c subjectlifecycle.ExecutionCommand
		if e = protocol.Decode(raw, &c); e != nil {
			return e
		}
		var p *subjectlifecycle.ProductDeletion
		p, e = product(pool, c.Endpoint, getenv)
		if e != nil {
			return e
		}
		result, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (map[string]any, error) {
			return subjectlifecycle.ExecuteWithin(ctx, tx, c, at, subjectlifecycle.ExecutionOptions{Product: p})
		})
	case "minimize":
		result, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (map[string]any, error) {
			return subjectlifecycle.MinimizeDeletionReceiptWithin(ctx, tx, raw, at, nil)
		})
	case "capture":
		var input struct {
			Endpoint string `json:"endpoint"`
		}
		if e = protocol.Decode(raw, &input); e != nil {
			return e
		}
		result, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (map[string]any, error) {
			return subjectlifecycle.CaptureDeletionLedgerWithin(ctx, tx, input.Endpoint, func() int64 { return time.Now().Unix() }, nil)
		})
	case "replay":
		var ledger []byte
		ledger, e = readInput(replay.LedgerPath, 20*1024*1024, true)
		if e != nil {
			return e
		}
		var command []byte
		command, e = protocol.EncodeJS(replay.ReplayCommand)
		if e != nil {
			return e
		}
		var p *subjectlifecycle.ProductDeletion
		p, e = product(pool, replay.Endpoint, getenv)
		if e != nil {
			return e
		}
		result, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (map[string]any, error) {
			return subjectlifecycle.ReplayDeletionLedgerWithin(ctx, tx, ledger, command, at, p, nil)
		})
	}
	if e != nil {
		return e
	}
	if mode == "capture" {
		artifact, ok := result["payloadJson"].(string)
		if !ok {
			return errors.New("invalid captured artifact")
		}
		if e = writeNew(outputPath, []byte(artifact)); e != nil {
			return e
		}
		return json.NewEncoder(stdout).Encode(map[string]any{"event": "deletion_ledger_captured", "sha256": result["sha256"], "capturedAt": result["capturedAt"], "bytes": result["bytes"], "requests": result["requests"]})
	}
	if e = writeReceipt(outputPath, result); e != nil {
		return e
	}
	summary := map[string]any{}
	switch mode {
	case "review":
		summary = map[string]any{"event": "deletion_review_recorded", "state": result["state"], "physicalDeletionPerformed": false}
	case "execute":
		summary = map[string]any{"event": "deletion_execution_recorded", "state": result["state"], "serviceWideDeletionComplete": false}
	case "replay":
		summary = map[string]any{"event": "deletion_ledger_replayed", "requests": result["requestsReplayed"], "quarantined": true, "publicActivationReady": false}
	case "minimize":
		var events any
		switch v := result["minimization"].(type) {
		case subjectlifecycle.MinimizationEvent:
			events = v.EventsMinimized
		case map[string]any:
			events = v["eventsMinimized"]
		}
		summary = map[string]any{"event": "deletion_receipt_minimized", "events": events, "serviceWideDeletionComplete": false}
	}
	return json.NewEncoder(stdout).Encode(summary)
}
func main() {
	if e := run(context.Background(), os.Args[1:], os.Getenv, os.LookupEnv, os.Stdout); e != nil {
		event := "deletion_maintenance_incomplete"
		if len(os.Args) > 1 {
			switch os.Args[1] {
			case "review":
				event = "deletion_review_failed"
			case "execute":
				event = "deletion_execution_failed"
			case "minimize":
				event = "deletion_minimization_incomplete"
			case "ledger":
				event = "deletion_ledger_operation_incomplete"
			}
		}
		_ = json.NewEncoder(os.Stderr).Encode(map[string]any{"event": event, "help": help, "code": fault.Code(e)})
		os.Exit(1)
	}
}
