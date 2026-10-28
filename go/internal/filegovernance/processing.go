// Package filegovernance owns metadata-only operational processing, access and
// approved cleanup of the original managed chat/forum attachments.
package filegovernance

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"math"
	"regexp"
	"time"
)

type Object = map[string]any

func str(o Object, k string) string { v, _ := o[k].(string); return v }
func obj(o Object, k string) Object { v, _ := o[k].(map[string]any); return v }
func truth(o Object, k string) bool { v, _ := o[k].(bool); return v }
func num(o Object, k string) int64 {
	switch n := o[k].(type) {
	case int:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case json.Number:
		v, _ := n.Int64()
		return v
	}
	return 0
}
func encode(v any) []byte                { b, _ := protocol.Encode(v); return b }
func fail(code string, status int) error { return fault.New(code, status) }
func timestamp(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t
	}
	s, _ := v.(string)
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t
}
func iso(v any) any {
	if v == nil {
		return nil
	}
	t := timestamp(v)
	if t.IsZero() {
		return nil
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}
func due(v any, now int64) bool { t := timestamp(v); return !t.IsZero() && t.UnixMilli() <= now*1000 }
func expiry(r Object) any {
	if r["expires_at"] != nil {
		return r["expires_at"]
	}
	return r["prepare_expires_at"]
}
func has(a []string, b string) bool {
	for _, v := range a {
		if v == b {
			return true
		}
	}
	return false
}
func table(kind string) (string, error) {
	switch kind {
	case "chat":
		return "chat_attachments", nil
	case "forum":
		return "forum_attachments_v1", nil
	}
	return "", fail("not_found", 404)
}

var processingError = regexp.MustCompile(`^attachment_[a-z0-9_]{1,70}$`)

func ProcessingVersion(r Object) string {
	var errorValue any
	if str(r, "last_error") != "" {
		errorValue = "unrecognized-processing-error"
		if processingError.MatchString(str(r, "last_error")) {
			errorValue = r["last_error"]
		}
	}
	return string(encode([]any{r["state"], r["scan_attempts"], iso(r["lease_until"]), r["lease_id"], r["purge_pending"], iso(r["revoked_at"]), iso(r["purged_at"]), iso(expiry(r)), num(r, "operations_retry_revision"), errorValue}))
}
func RetryState(r Object, now int64) Object {
	active := r["lease_id"] != nil && r["lease_until"] != nil && !due(r["lease_until"], now)
	scan := r["purged_at"] == nil && r["revoked_at"] == nil && !due(expiry(r), now) && !truth(r, "purge_pending") && has([]string{"scan-pending", "scanning"}, str(r, "state")) && !active
	return Object{"scan": scan, "cleanup": false, "activeLease": active}
}
func ProcessingFacts(r Object, now int64) Object {
	expired, removed := due(expiry(r), now), r["purged_at"] != nil
	active := truth(RetryState(r, now), "activeLease")
	unknown := !removed && truth(r, "purge_pending") && str(r, "last_error") == "attachment_cleanup_failed"
	needs := !removed && (truth(r, "purge_pending") || r["revoked_at"] != nil || expired)
	scanFailed := !removed && has([]string{"scan-pending", "scanning"}, str(r, "state")) && num(r, "scan_attempts") > 0 && str(r, "last_error") != "" && str(r, "last_error") != "attachment_cleanup_failed"
	scan := "unavailable"
	result := obj(r, "scan_result")
	if has([]string{"clean", "blocked"}, str(result, "state")) {
		scan = str(result, "state")
	} else if !removed && str(r, "state") == "scanning" && active {
		scan = "running"
	} else if scanFailed {
		scan = "failed"
	} else if !removed && has([]string{"scan-pending", "scanning"}, str(r, "state")) {
		scan = "pending"
	} else if !removed && has([]string{"prepared", "uploading"}, str(r, "state")) {
		scan = "not-started"
	}
	checked := checkedISO(result["checkedAt"])
	state := str(r, "state")
	if removed {
		state = "erased"
	} else if r["revoked_at"] != nil {
		state = "revoked"
	} else if expired {
		state = "expired"
	}
	cleanup := "not-requested"
	if removed {
		cleanup = "removed"
	} else if unknown {
		cleanup = "result-unknown"
	} else if needs {
		cleanup = "pending"
	}
	var blocked any
	if !removed {
		blocked = "plan-authorization-required"
	}
	return Object{"expired": expired, "removed": removed, "activeLease": active, "needsCleanup": needs, "cleanupUnknown": unknown, "scanFailed": scanFailed, "state": state, "scan": Object{"state": scan, "checkedAt": checked}, "cleanup": Object{"state": cleanup, "executionObserved": false, "failureObserved": nil, "objectRemoved": removed, "physicalBlocksReleased": nil, "authorization": "legacy-plan-required", "retryBlockedReason": blocked}}
}
func checkedISO(value any) any {
	var n float64
	switch v := value.(type) {
	case int:
		n = float64(v)
	case int64:
		n = float64(v)
	case float64:
		n = v
	case json.Number:
		n, _ = v.Float64()
	default:
		return nil
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n <= 0 || n > 8640000000000 {
		return nil
	}
	return iso(time.UnixMilli(int64(n * 1000)))
}
func RetryProcessingWithin(ctx context.Context, tx pgx.Tx, kind string, r, input Object, now int64, authorUnavailable bool) (Object, error) {
	name, e := table(kind)
	if e != nil {
		return nil, e
	}
	if ProcessingVersion(r) != str(input, "expectedVersion") {
		return nil, fail("operations_file_changed", 409)
	}
	if str(input, "kind") == "cleanup" {
		return nil, fail("operations_file_cleanup_authorization_required", 409)
	}
	if !truth(RetryState(r, now), str(input, "kind")) || str(input, "kind") == "scan" && authorUnavailable {
		return nil, fail("operations_file_retry_unavailable", 409)
	}
	return row(ctx, tx, fmt.Sprintf("UPDATE %s SET lease_id=NULL,lease_until=NULL,last_error=NULL,operations_retry_revision=operations_retry_revision+1 WHERE id=$1 RETURNING to_jsonb(%s)", name, name), r["id"])
}
func row(ctx context.Context, tx pgx.Tx, sql string, args ...any) (Object, error) {
	var raw []byte
	e := tx.QueryRow(ctx, sql, args...).Scan(&raw)
	if e == pgx.ErrNoRows {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var r Object
	e = json.Unmarshal(raw, &r)
	return r, e
}
func rows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rr, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rr.Close()
	out := []Object{}
	for rr.Next() {
		var raw []byte
		if e = rr.Scan(&raw); e != nil {
			return nil, e
		}
		var r Object
		if e = json.Unmarshal(raw, &r); e != nil {
			return nil, e
		}
		out = append(out, r)
	}
	return out, rr.Err()
}
