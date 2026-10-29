package operationsautonomy

import "github.com/agigalaxy-team/agigalaxy/go/internal/fault"

// RequireNativeAttempt binds callbacks to the current immutable attempt.
// Legacy tasks require the field to be absent or null on both sides.
func RequireNativeAttempt(row Object, input Object) error {
	expected, actual := str(row["native_attempt_id"]), str(input["nativeAttemptId"])
	if expected == "" && actual == "" {
		return nil
	}
	if !uuidPattern.MatchString(expected) || !uuidPattern.MatchString(actual) || expected != actual {
		return fault.New("operations_autonomy_native_attempt_mismatch", 403)
	}
	return nil
}

// taskJobInput pins queued worker jobs to an attempt and its session.
func taskJobInput(row Object, reconcile bool) Object {
	out := Object{"taskId": row["id"]}
	if reconcile {
		out["reconcile"] = true
	}
	if row["native_attempt_id"] != nil {
		out["nativeAttemptId"] = row["native_attempt_id"]
		out["sessionId"] = row["session_id"]
	}
	return out
}
