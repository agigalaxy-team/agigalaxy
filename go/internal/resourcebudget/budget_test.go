package resourcebudget

import (
	"encoding/json"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

type oracleUsage struct {
	PayloadBytes  string `json:"payloadBytes"`
	QueuedJobs    int64  `json:"queuedJobs"`
	ActiveExports int64  `json:"activeExports"`
}

func (u oracleUsage) native() Usage {
	bytes, _ := new(big.Int).SetString(u.PayloadBytes, 10)
	return Usage{bytes, u.QueuedJobs, u.ActiveExports}
}
func TestOriginalResourceBudgetPolicySQLAndGrowthParity(t *testing.T) {
	policy := DefaultPolicy()
	type growthCase struct {
		Before oracleUsage `json:"before"`
		After  oracleUsage `json:"after"`
		Policy Policy      `json:"policy"`
	}
	cases := []growthCase{}
	add := func(before, after oracleUsage) { cases = append(cases, growthCase{before, after, policy}) }
	add(oracleUsage{"0", 0, 0}, oracleUsage{"1048576", 32, 3})
	add(oracleUsage{"1048576", 0, 0}, oracleUsage{"1048577", 0, 0})
	add(oracleUsage{"1048577", 0, 0}, oracleUsage{"1048577", 0, 0})
	add(oracleUsage{"1048578", 0, 0}, oracleUsage{"1048577", 0, 0})
	add(oracleUsage{"0", 32, 0}, oracleUsage{"0", 33, 0})
	add(oracleUsage{"0", 33, 0}, oracleUsage{"0", 33, 0})
	add(oracleUsage{"0", 34, 0}, oracleUsage{"0", 33, 0})
	add(oracleUsage{"0", 0, 3}, oracleUsage{"0", 0, 4})
	add(oracleUsage{"0", 0, 4}, oracleUsage{"0", 0, 4})
	add(oracleUsage{"0", 0, 5}, oracleUsage{"0", 0, 4})
	add(oracleUsage{"9223372036854775808", 0, 0}, oracleUsage{"9223372036854775809", 0, 0})
	add(oracleUsage{"9223372036854775808", 0, 0}, oracleUsage{"9223372036854775808", 0, 0})
	add(oracleUsage{"0", 0, 0}, oracleUsage{"1048577", 33, 4})
	add(oracleUsage{"0", 0, 0}, oracleUsage{"0", 33, 4})
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
	input, _ := json.Marshal(map[string]any{"cases": cases, "policies": policies})
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/resource-budget-interop.mjs"), "oracle")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(string(input))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original JS budget oracle: %v %s", e, out)
	}
	var oracle struct {
		Queries       []string
		DefaultPolicy Policy
		Validations   []bool
		Outcomes      []*string
	}
	if e = json.Unmarshal(out, &oracle); e != nil {
		t.Fatal(e)
	}
	if !reflect.DeepEqual(oracle.DefaultPolicy, policy) {
		t.Fatal("default policy differs from original loader")
	}
	for i, query := range []string{subjectPayloadSQL, subjectJobsSQL, subjectExportsSQL} {
		if query != oracle.Queries[i] {
			t.Fatalf("original SQL query %d differs", i)
		}
	}
	for i, c := range cases {
		code := ""
		if e = EnforceResourceGrowth(c.Before.native(), c.After.native(), c.Policy); e != nil {
			code = fault.Code(e)
		}
		want := ""
		if oracle.Outcomes[i] != nil {
			want = *oracle.Outcomes[i]
		}
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
		if (e == nil) != oracle.Validations[i] {
			t.Fatalf("policy case %d differs from original parse", i)
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
