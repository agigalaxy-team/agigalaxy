package operationsqueries

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOriginalFiveDomainSummaryProjectionDoesNotCarrySourceProse(t *testing.T) {
	at := "2033-05-18T03:33:20.000Z"
	id := "00000000-0000-4000-8000-000000000001"
	availability := Object{"recentOperations": "available", "ai": "available"}
	value := Object{"checkedAt": 2000000000, "readExpiresAt": 2000000030, "availability": availability, "operator": Object{"id": "private operator"}, "privateBody": "must not escape", "recentOperations": []any{Object{"action": "notice-create", "createdAt": at, "body": "must not escape"}, Object{"action": "community-report-resolve", "createdAt": at}, Object{"action": "search-quality.publish", "createdAt": at}, Object{"action": "INVALID PROSE", "createdAt": at}}, "autonomy": Object{"checkedAt": 2000000000, "readExpiresAt": 2000000030, "summary": Object{"active": 2, "queued": -1, "failed": 0}, "accounts": []any{Object{"domain": "messaging", "config": Object{"enabled": true, "privatePrompt": "must not escape"}, "health": "healthy", "lastValidAt": at}}, "recentTasks": []any{Object{"id": id, "domain": "messaging", "source": "routine", "state": "completed", "updatedAt": at, "modelState": "completed", "businessState": "no-action", "privatePrompt": "must not escape"}}}}
	for key, fields := range countFields {
		availability[key] = "available"
		row := Object{}
		for _, field := range fields {
			row[field] = 1
		}
		value[key] = row
	}
	inputs, got := []Object{}, []Object{}
	for domain := range summaryBlocks {
		for _, p := range [][]string{{}, {"autonomy.read"}} {
			inputs = append(inputs, Object{"value": value, "domain": domain, "permissions": p})
			got = append(got, ConversationSummary(value, domain, p))
		}
	}
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/operationsqueries/testdata/summary-oracle.mjs"))
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(encoded(inputs))
	raw, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original summary %v %s", e, raw)
	}
	var expected []Object
	if json.Unmarshal(raw, &expected) != nil {
		t.Fatal("invalid original summary")
	}
	var normal []Object
	_ = json.Unmarshal([]byte(encoded(got)), &normal)
	if !reflect.DeepEqual(normal, expected) {
		t.Fatalf("domain summary differs Go=%s JS=%s", encoded(normal), encoded(expected))
	}
	if strings.Contains(encoded(got), "must not escape") || strings.Contains(encoded(got), "private operator") {
		t.Fatal("source prose crossed bounded summary projection")
	}
}
