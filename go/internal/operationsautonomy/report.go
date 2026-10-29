package operationsautonomy

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var nativeRunPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var modelStates = []string{"not-started", "dispatching", "accepted", "running", "completed", "failed", "cancelled", "unknown", "not-required"}

func parseReport(input Object) (Object, error) {
	if !closed(input, []string{"taskId", "modelState", "status"}, []string{"nativeRunId", "code", "summary", "finalAnalysis"}) || !schemaUUID.MatchString(str(input["taskId"])) || !has(modelStates, str(input["modelState"])) || !has([]string{"running", "waiting-human", "completed", "failed", "unknown"}, str(input["status"])) {
		return nil, invalid()
	}
	if v, ok := input["nativeRunId"]; ok && !nativeRunPattern.MatchString(str(v)) {
		return nil, invalid()
	}
	if v, ok := input["code"]; ok && !safeCode.MatchString(str(v)) {
		return nil, invalid()
	}
	if v, ok := input["summary"]; ok {
		if _, ok := text(v, 0, 4000, false); !ok {
			return nil, invalid()
		}
	}
	if v, ok := input["finalAnalysis"]; ok {
		a := obj(v)
		if input["modelState"] != "completed" || input["status"] != "completed" || !nativeRunPattern.MatchString(str(input["nativeRunId"])) {
			return nil, invalid()
		}
		switch a["state"] {
		case "available":
			value, ok := a["text"].(string)
			if !closed(a, []string{"state", "text"}, nil) || !ok || !utf8.ValidString(value) || strings.TrimSpace(value) == "" || len(value) > 12000 {
				return nil, invalid()
			}
		case "too-large":
			if !closed(a, []string{"state", "byteLength"}, nil) || !integer(a["byteLength"], 12001, 9007199254740991) {
				return nil, invalid()
			}
		default:
			return nil, invalid()
		}
	}
	return obj(clone(input)), nil
}
func (s *Service) Report(ctx context.Context, input Object) (Object, error) {
	x, e := parseReport(input)
	if e != nil {
		return nil, e
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		row, e := s.taskWithin(ctx, tx, str(x["taskId"]), " FOR UPDATE")
		if e != nil {
			return nil, e
		}
		if row["dispatch_started_at"] == nil {
			return nil, fail("operations_autonomy_task_inactive")
		}
		if str(row["native_run_id"]) != "" && str(x["nativeRunId"]) != "" && row["native_run_id"] != x["nativeRunId"] {
			return nil, fail("operations_autonomy_operation_conflict")
		}
		lateAnalysis := x["finalAnalysis"] != nil && has([]string{"unknown", "paused", "waiting-human"}, str(row["state"]))
		if lateAnalysis || has(terminal, str(row["state"])) || has([]string{"paused", "waiting-human"}, str(row["state"])) && row["human_decision"] != nil {
			if x["finalAnalysis"] != nil && has([]string{"completed", "failed", "unknown"}, str(row["state"])) && row["model_state"] == "completed" && str(row["native_run_id"]) != "" && row["native_run_id"] == x["nativeRunId"] && !has([]string{"stop", "stopped", "pause", "paused", "takeover"}, str(obj(row["human_decision"])["kind"])) {
				if e = s.storeFinalAnalysisWithin(ctx, tx, row, x); e != nil {
					return nil, e
				}
			}
			if x["finalAnalysis"] != nil {
				return s.stamp(Object{"taskId": row["id"], "state": row["state"]}), nil
			}
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET native_run_id=COALESCE(native_run_id,$3),model_state=$4 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], x["nativeRunId"], x["modelState"]); e != nil {
				return nil, e
			}
			return s.stamp(Object{"taskId": row["id"], "state": row["state"]}), nil
		}
		completion, e := s.completionWithin(ctx, tx, row, row["mode"] != "code")
		if e != nil {
			return nil, e
		}
		business := str(completion["businessState"])
		state := str(x["status"])
		if state == "failed" && completion["disposition"] == "unknown" {
			state = "unknown"
		}
		if state == "completed" {
			switch completion["disposition"] {
			case "waiting-human":
				state = "waiting-human"
			case "failed":
				state = "failed"
			case "unknown", "continue":
				state = "unknown"
			}
		}
		done := state == "completed" || state == "failed"
		code := x["code"]
		if code == nil && state != "completed" && x["status"] == "completed" {
			code = completion["reasonCode"]
		}
		if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state=$3,model_state=$4,business_state=$5,native_run_id=COALESCE(native_run_id,$6),code=$7,lease_until=CASE WHEN $8 OR $3='waiting-human' THEN NULL ELSE lease_until END,completed_at=CASE WHEN $8 THEN $9 ELSE completed_at END,revision=revision+1,updated_at=$9 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["id"], state, x["modelState"], business, x["nativeRunId"], code, done, s.now()); e != nil {
			return nil, e
		}
		if x["finalAnalysis"] != nil {
			if e = s.storeFinalAnalysisWithin(ctx, tx, row, x); e != nil {
				return nil, e
			}
		}
		if state == "completed" && row["effective_check"] == true {
			if _, e = tx.Exec(ctx, `UPDATE operations_autonomy_configs_v1 SET last_valid_at=$3 WHERE endpoint=$1 AND id=$2`, s.Endpoint, row["config_id"], s.now()); e != nil {
				return nil, e
			}
		}
		return s.stamp(Object{"taskId": row["id"], "state": state, "modelState": x["modelState"], "businessState": business}), nil
	})
}

func (s *Service) storeFinalAnalysisWithin(ctx context.Context, tx pgx.Tx, row, report Object) error {
	input := obj(report["finalAnalysis"])
	if input == nil {
		return nil
	}
	prior := obj(row["result"])
	if prior != nil {
		a := obj(prior["analysis"])
		if prior["schemaVersion"] == float64(1) && a["basis"] == "native-run-final-content" && a["nativeRunId"] == report["nativeRunId"] && ((a["state"] == input["state"] && a["text"] == input["text"] && a["byteLength"] == input["byteLength"]) || (input["state"] == "available" && a["state"] == "too-large" && a["reason"] == "encoded-result-limit" && a["textDigest"] == analysisDigest(str(input["text"])))) {
			return nil
		}
		return fail("operations_autonomy_operation_conflict")
	}
	analysis := Object{"state": input["state"], "basis": "native-run-final-content", "nativeRunId": report["nativeRunId"], "recordedAt": s.now().UTC().Format(time.RFC3339Nano)}
	if input["state"] == "available" {
		analysis["text"] = input["text"]
	} else {
		analysis["byteLength"] = input["byteLength"]
		analysis["reason"] = "text-limit"
	}
	result := Object{"schemaVersion": 1, "analysis": analysis}
	if len(jsonText(result)) > 16370 {
		analysis = Object{"state": "too-large", "basis": "native-run-final-content", "nativeRunId": report["nativeRunId"], "recordedAt": s.now().UTC().Format(time.RFC3339Nano), "byteLength": len(str(input["text"])), "reason": "encoded-result-limit", "textDigest": analysisDigest(str(input["text"]))}
		result["analysis"] = analysis
	}
	_, err := tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET result=$3::jsonb,revision=revision+1,updated_at=$4 WHERE endpoint=$1 AND id=$2 AND result IS NULL`, s.Endpoint, row["id"], jsonText(result), s.now())
	return err
}
func analysisDigest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func (s *Service) WaitForHumanWithin(ctx context.Context, tx pgx.Tx, taskID, operationID, code string) error {
	if code == "" {
		code = "operations_autonomy_human_required"
	}
	row, e := s.taskWithin(ctx, tx, taskID, " FOR UPDATE")
	if e != nil {
		return e
	}
	if has(terminal, str(row["state"])) {
		return nil
	}
	_, e = tx.Exec(ctx, `UPDATE operations_autonomy_tasks_v1 SET state='waiting-human',human_decision=$3,lease_until=NULL,revision=revision+1,code=$4,updated_at=$5 WHERE endpoint=$1 AND id=$2`, s.Endpoint, taskID, jsonText(Object{"kind": "decision-required", "operationId": operationID, "code": code, "at": s.now().UTC().Format("2006-01-02T15:04:05.000Z")}), code, s.now())
	return e
}
