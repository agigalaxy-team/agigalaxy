package resourcebudget

import (
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type fixtureUsage struct {
	PayloadBytes  string `json:"payloadBytes"`
	QueuedJobs    int64  `json:"queuedJobs"`
	ActiveExports int64  `json:"activeExports"`
}

func (u fixtureUsage) native() Usage {
	bytes, _ := new(big.Int).SetString(u.PayloadBytes, 10)
	return Usage{bytes, u.QueuedJobs, u.ActiveExports}
}
func TestResourceBudgetPolicyAndGrowth(t *testing.T) {
	policy := DefaultPolicy()
	type growthCase struct {
		Before fixtureUsage `json:"before"`
		After  fixtureUsage `json:"after"`
		Policy Policy       `json:"policy"`
	}
	cases := []growthCase{}
	add := func(before, after fixtureUsage) { cases = append(cases, growthCase{before, after, policy}) }
	add(fixtureUsage{"0", 0, 0}, fixtureUsage{"1048576", 32, 3})
	add(fixtureUsage{"1048576", 0, 0}, fixtureUsage{"1048577", 0, 0})
	add(fixtureUsage{"1048577", 0, 0}, fixtureUsage{"1048577", 0, 0})
	add(fixtureUsage{"1048578", 0, 0}, fixtureUsage{"1048577", 0, 0})
	add(fixtureUsage{"0", 32, 0}, fixtureUsage{"0", 33, 0})
	add(fixtureUsage{"0", 33, 0}, fixtureUsage{"0", 33, 0})
	add(fixtureUsage{"0", 34, 0}, fixtureUsage{"0", 33, 0})
	add(fixtureUsage{"0", 0, 3}, fixtureUsage{"0", 0, 4})
	add(fixtureUsage{"0", 0, 4}, fixtureUsage{"0", 0, 4})
	add(fixtureUsage{"0", 0, 5}, fixtureUsage{"0", 0, 4})
	add(fixtureUsage{"9223372036854775808", 0, 0}, fixtureUsage{"9223372036854775809", 0, 0})
	add(fixtureUsage{"9223372036854775808", 0, 0}, fixtureUsage{"9223372036854775808", 0, 0})
	add(fixtureUsage{"0", 0, 0}, fixtureUsage{"1048577", 33, 4})
	add(fixtureUsage{"0", 0, 0}, fixtureUsage{"0", 33, 4})
	good, _ := json.Marshal(policy)
	var values map[string]any
	_ = json.Unmarshal(good, &values)
	policies := []map[string]any{values}
	for key := range values {
		copy := map[string]any{}
		for k, v := range values {
			copy[k] = v
		}
		copy[key] = nil
		policies = append(policies, copy)
	}
	for key, bad := range map[string]any{"maxPayloadBytesPerSubject": float64(1099511627777), "maxQueuedJobsPerSubject": float64(0), "maxActiveExportsPerSubject": float64(1001), "maxActiveJobsGlobal": float64(0), "maxActiveJobsPerSubject": float64(1001), "extraRule": true} {
		copy := map[string]any{}
		for k, v := range values {
			copy[k] = v
		}
		copy[key] = bad
		policies = append(policies, copy)
	}
	if policy != (Policy{1, 1048576, 32, 3, 4, 1}) {
		t.Fatal("published defaults", policy)
	}
	outcomes := []string{"", "storage_quota_exceeded", "", "", "job_queue_quota_exceeded", "", "", "export_ticket_quota_exceeded", "", "", "storage_quota_exceeded", "", "storage_quota_exceeded", "job_queue_quota_exceeded"}
	var e error
	for i, c := range cases {
		code := ""
		if e = EnforceResourceGrowth(c.Before.native(), c.After.native(), c.Policy); e != nil {
			code = fault.Code(e)
		}
		want := outcomes[i]
		if code != want {
			t.Fatalf("growth case %d: %q want %q", i, code, want)
		}
	}
	file := filepath.Join(t.TempDir(), "resource-budget.json")
	for i, value := range policies {
		b, _ := json.Marshal(value)
		if e = os.WriteFile(file, b, 0600); e != nil {
			t.Fatal(e)
		}
		_, e = Load(file)
		if (e == nil) != (i == 0) {
			t.Fatalf("policy case %d validation", i)
		}
	}
	first, e := Load("")
	if e != nil {
		t.Fatal(e)
	}
	first.MaxPayloadBytesPerSubject = 0
	second, e := Load("")
	if e != nil || second.MaxPayloadBytesPerSubject != policy.MaxPayloadBytesPerSubject {
		t.Fatal("default policy was not cloned")
	}
	if _, e = Load("relative.json"); e == nil {
		t.Fatal("relative policy path accepted")
	}
}
