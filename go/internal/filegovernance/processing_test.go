package filegovernance

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func original(t *testing.T, mode string, input any) Object {
	t.Helper()
	path, _ := filepath.Abs(filepath.Join("testdata", "interop.mjs"))
	cmd := exec.Command("node", path, mode)
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL=postgres://127.0.0.1/galaxy_go_test_file_oracle")
	cmd.Stdin = bytes.NewReader(encode(input))
	raw, e := cmd.Output()
	if e != nil {
		if ee, ok := e.(*exec.ExitError); ok {
			t.Fatalf("original oracle: %s", ee.Stderr)
		}
		t.Fatal(e)
	}
	var out Object
	if e = json.Unmarshal(raw, &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func equal(t *testing.T, a, b any) {
	t.Helper()
	left, right := encode(a), encode(b)
	var x, y any
	json.Unmarshal(left, &x)
	json.Unmarshal(right, &y)
	lx, ly := encode(x), encode(y)
	if !bytes.Equal(lx, ly) {
		t.Fatalf("original projection differed\nGo: %s\nJS: %s", lx, ly)
	}
}
func TestOriginalFileProcessingAndCleanupFacts(t *testing.T) {
	now := int64(2000000000)
	at := func(n int64) any { return iso(time.Unix(n, 0)) }
	rows := []Object{}
	for _, state := range []string{"prepared", "uploading", "scan-pending", "scanning", "available", "blocked", "erased"} {
		for _, variant := range []string{"clean", "blocked", "unknown", "error", "lease", "revoked", "purged", "expired"} {
			r := Object{"state": state, "scan_attempts": 2, "lease_until": nil, "lease_id": nil, "purge_pending": false, "revoked_at": nil, "purged_at": nil, "expires_at": at(now + 100), "prepare_expires_at": at(now + 200), "operations_retry_revision": 1, "last_error": nil, "scan_result": nil}
			switch variant {
			case "clean", "blocked":
				r["scan_result"] = Object{"state": variant, "checkedAt": float64(now) - 0.25}
			case "error":
				r["last_error"] = "attachment_scan_failed"
			case "unknown":
				r["last_error"] = "private-unrecognized-error"
			case "lease":
				r["lease_id"] = "00000000-0000-0000-0000-000000000000"
				r["lease_until"] = at(now + 20)
			case "revoked":
				r["revoked_at"] = at(now - 1)
			case "purged":
				r["purged_at"] = at(now - 1)
			case "expired":
				r["expires_at"] = at(now - 1)
			}
			rows = append(rows, r)
		}
	}
	cases := []Object{}
	for _, r := range rows {
		for _, source := range []Object{{"kind": "chat", "linked": false, "references": []any{}, "activeReferences": 0, "explicitWithdrawal": false, "truncated": false}, {"kind": "forum", "linked": true, "references": []any{}, "activeReferences": nil, "explicitWithdrawal": false, "truncated": true}, {"kind": "forum", "linked": true, "references": []any{}, "activeReferences": 0, "explicitWithdrawal": false, "truncated": false}, {"kind": "forum", "linked": true, "references": []any{}, "activeReferences": 1, "explicitWithdrawal": true, "truncated": false}} {
			cases = append(cases, Object{"row": r, "source": source})
		}
	}
	f := original(t, "oracle", Object{"now": now, "rows": rows, "eligibility": cases})
	for i, value := range f["rows"].([]any) {
		equal(t, Object{"version": ProcessingVersion(rows[i]), "facts": ProcessingFacts(rows[i], now), "retry": RetryState(rows[i], now)}, value)
	}
	for i, value := range f["eligibility"].([]any) {
		equal(t, CleanupEligibility(obj(cases[i], "row"), obj(cases[i], "source"), now), value)
	}
}
