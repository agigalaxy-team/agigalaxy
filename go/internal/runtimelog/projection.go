package runtimelog

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/failureaudit"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5/pgconn"
	"math"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Event = map[string]any

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`)
var releasePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`)
var serviceCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,99}$`)
var sourcePattern = regexp.MustCompile(`(?:^|/)(packages/(?:galaxy-official/(?:src|scripts|deploy)|galaxy-(?:client|contracts)/src)/[a-zA-Z0-9_./-]+\.(?:mjs|js)|go/(?:internal|cmd)/[a-zA-Z0-9_./-]+\.go)$`)
var dependencyPattern = regexp.MustCompile(`(?:^|/)node_modules/((?:pg|pg-pool|pg-boss|pino|rotating-file-stream|@electric-sql/pglite)/[a-zA-Z0-9_./-]+\.(?:mjs|cjs|js))$`)

func text(v any) string { s, _ := v.(string); return s }
func number(v any) (float64, bool) {
	switch n := v.(type) {
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint64:
		if n <= 9007199254740991 {
			return float64(n), true
		}
	case float64:
		return n, !math.IsNaN(n) && !math.IsInf(n, 0)
	case time.Duration:
		return float64(n) / float64(time.Millisecond), true
	}
	return 0, false
}
func integer(v any, min, max float64) bool {
	n, ok := number(v)
	return ok && math.Trunc(n) == n && n >= min && n <= max
}
func oneOf(v string, values ...string) bool {
	for _, s := range values {
		if v == s {
			return true
		}
	}
	return false
}
func safeFile(s string) string {
	s = filepath.ToSlash(s)
	s = strings.ReplaceAll(s, `\`, "/")
	if strings.Contains("/"+s+"/", "/../") {
		return ""
	}
	if regexp.MustCompile(`^node:[a-zA-Z0-9_/-]+$`).MatchString(s) {
		return s
	}
	if m := sourcePattern.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	if m := dependencyPattern.FindStringSubmatch(s); m != nil {
		return "node_modules/" + m[1]
	}
	return ""
}
func formattedError(input Event, depth int) Event {
	name := text(input["errorName"])
	if name != "ServiceError" && !names[name] {
		return Event{}
	}
	code := text(input["errorCode"])
	if !machineCodes[code] && code != "PROCESS_EXIT" && !(name == "ServiceError" && serviceCode.MatchString(code)) {
		code = "unclassified_error"
	}
	frames := []any{}
	list, _ := input["stackFrames"].([]any)
	for i, v := range list {
		if i >= 12 {
			break
		}
		frame, _ := v.(map[string]any)
		file := safeFile(text(frame["file"]))
		if file != "" && integer(frame["line"], 1, 10000000) && integer(frame["column"], 1, 1000000) {
			frames = append(frames, Event{"file": file, "line": frame["line"], "column": frame["column"]})
		}
	}
	result := Event{"errorName": name, "errorCode": code, "stackFrames": frames}
	if integer(input["errorExitCode"], 0, 255) {
		result["errorExitCode"] = input["errorExitCode"]
	}
	if oneOf(text(input["errorSignal"]), "SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV") {
		result["errorSignal"] = input["errorSignal"]
	}
	if cause, ok := input["cause"].(map[string]any); ok && depth < 2 && text(cause["errorName"]) != "" {
		result["cause"] = formattedError(cause, depth+1)
	}
	return result
}

// SafeError never calls Error() or prints a Go stack/SQL/detail/path. Only known
// concrete machine codes and at most two wrapped causes cross this boundary.
func SafeError(err error) Event { return safeError(err, 0) }
func safeError(err error, depth int) Event {
	result := Event{"errorName": "Error", "errorCode": "unclassified_error", "stackFrames": []any{}}
	switch e := err.(type) {
	case *fault.Error:
		result["errorName"] = "ServiceError"
		if serviceCode.MatchString(e.Code) {
			result["errorCode"] = e.Code
		}
	case *pgconn.PgError:
		result["errorName"] = "DatabaseError"
		if machineCodes[e.Code] {
			result["errorCode"] = e.Code
		}
	case *exec.ExitError:
		code := e.ExitCode()
		if code >= 0 && code <= 255 {
			result["errorCode"] = "PROCESS_EXIT"
			result["errorExitCode"] = code
		}
	}
	if depth < 2 && err != nil {
		if cause := errors.Unwrap(err); cause != nil {
			result["cause"] = safeError(cause, depth+1)
		}
	}
	return result
}

type fieldsKey struct{}

// WithContext carries only the selected diagnostic fields to derived contexts.
func WithContext(ctx context.Context, fields Event) context.Context {
	merged := Event{}
	if old, ok := ctx.Value(fieldsKey{}).(Event); ok {
		for k, v := range old {
			merged[k] = v
		}
	}
	for k, v := range diagnostic(fields) {
		merged[k] = v
	}
	return context.WithValue(ctx, fieldsKey{}, merged)
}
func diagnostic(input Event) Event {
	result := Event{}
	for _, key := range []string{"requestId", "jobId", "resourceId"} {
		if v := text(input[key]); uuidPattern.MatchString(v) {
			result[key] = v
		}
	}
	for key, allowed := range map[string]map[string]bool{"stage": stages, "queue": queues, "outcome": outcomes} {
		if v := text(input[key]); allowed[v] {
			result[key] = v
		}
	}
	if integer(input["attempt"], 0, 9007199254740991) {
		result["attempt"] = input["attempt"]
	}
	if elapsed, ok := number(input["durationMs"]); ok && elapsed >= 0 && elapsed <= 31536000000 {
		result["durationMs"] = math.Floor(elapsed*1000+0.5) / 1000
	}
	var formatted Event
	if err, ok := input["error"].(error); ok {
		formatted = SafeError(err)
	} else if _, ok := input["error"]; ok {
		formatted = SafeError(nil)
	} else {
		formatted = formattedError(input, 0)
	}
	for k, v := range formatted {
		result[k] = v
	}
	return result
}
func Project(input Event) Event {
	event := text(input["event"])
	if !events[event] {
		if _, ok := input["event"]; !ok && integer(input["status"], -9007199254740991, 9007199254740991) {
			event = "http_rejected"
		} else {
			event = "runtime_event_rejected"
		}
	}
	result := Event{"event": event}
	if v := text(input["requestId"]); uuidPattern.MatchString(v) && v == strings.ToLower(v) {
		result["requestId"] = v
	}
	if integer(input["status"], 100, 599) {
		result["status"] = input["status"]
	}
	if v, ok := input["code"]; ok {
		code := text(v)
		if !codes[code] {
			code = "other_error"
		}
		result["code"] = code
	}
	for key, allowed := range map[string]map[string]bool{"phase": phases, "delivery": deliveries, "auditStatus": audits} {
		if v := text(input[key]); allowed[v] {
			result[key] = v
		}
	}
	if v := text(input["state"]); oneOf(v, "observed", "revoked", "unavailable", "indexed", "hidden", "pending", "failed", "reachable", "authentication-required", "protocol-mismatch", "removed", "source-changed", "delivered", "confirmed", "result-unknown", "source-unavailable", "excluded") {
		result["state"] = v
	}
	if v := text(input["target"]); oneOf(v, "openpanel", "gorse") {
		result["target"] = v
	}
	for _, key := range []string{"count", "pending", "version", "port"} {
		if integer(input[key], 0, 9007199254740991) {
			result[key] = input[key]
		}
	}
	route := text(input["route"])
	if route == "http.request" || route == "http.parser" {
		result["route"] = route
	} else {
		parts := strings.SplitN(route, " ", 2)
		if len(parts) == 2 && oneOf(parts[0], "GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS") && strings.HasPrefix(parts[1], "/") && !strings.ContainsAny(parts[1], "?# \t\r\n") {
			result["route"] = failureaudit.FailureRoute(parts[0], parts[1])
		}
	}
	if v := text(input["signal"]); oneOf(v, "SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection") {
		result["signal"] = v
	}
	if integer(input["exitCode"], 0, 255) {
		result["exitCode"] = input["exitCode"]
	}
	for k, v := range diagnostic(input) {
		result[k] = v
	}
	return result
}
