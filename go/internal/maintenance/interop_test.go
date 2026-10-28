package maintenance

import (
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func jsFixture(t *testing.T, input Object) Object {
	t.Helper()
	root, _ := filepath.Abs("../../..")
	b, _ := json.Marshal(input)
	c := exec.Command("node", filepath.Join(root, "scripts/go/maintenance-interop.mjs"))
	c.Dir = root
	c.Stdin = strings.NewReader(string(b))
	raw, e := c.CombinedOutput()
	if e != nil {
		t.Fatalf("original maintenance: %v %s", e, raw)
	}
	var o Object
	if e = json.Unmarshal(raw, &o); e != nil {
		t.Fatal(e)
	}
	return o
}
func normalized(v any) any { b, _ := json.Marshal(v); var x any; _ = json.Unmarshal(b, &x); return x }
func TestOriginalMaintenanceSchemaAndMetadata(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	hash := strings.Repeat("a", 64)
	input := Object{"logs": []Object{{}, {"limit": "0x10", "before": "2026-10-28T12:00:00+08:00"}, {"limit": 0}, {"extra": true}, {"before": "1234567890123456"}, {"before": "2026-02-30T00:00:00Z"}}, "backups": []Object{{}, {"after": hash}, {"limit": true}, {"limit": []any{2}}}, "plans": []Object{{}, {"after": id}}, "page": []Object{{}, {"after": "0"}, {"after": "9999999999999999"}}, "backup": []Object{{"operationId": id, "kind": "create"}, {"operationId": id, "kind": "verify"}, {"operationId": id, "kind": "verify", "pointId": hash}}, "create": []Object{{"operationId": id, "pointId": hash}, {"operationId": id, "pointId": hash, "scope": "selected-modules", "moduleIds": []string{ModuleIDs()[0]}}, {"operationId": id, "pointId": hash, "moduleIds": []string{ModuleIDs()[0]}}}, "approve": []Object{{"operationId": id, "expectedRevision": 1, "expectedPlanDigest": hash, "acknowledgement": Object{"point": true, "scope": true, "possibleLoss": true, "openingConditions": true}}}, "execute": []Object{{"operationId": id, "expectedRevision": 1}, {"operationId": id, "expectedRevision": "1"}}, "native": []Object{{"kind": "overview"}, {"kind": "backup-create", "operationId": id, "operatorId": strings.Repeat("😀", 500)}, {"kind": "backup-create", "operationId": id, "operatorId": strings.Repeat("😀", 501)}}, "overview": []Object{{}, {"components": []Object{{"id": "api", "processState": "running", "health": "healthy", "healthBasis": "systemd-process", "checkedAt": "2026-10-28T00:00:00Z"}}}, {"components": []Object{{"id": "website", "processState": "not-applicable", "processBasis": "static-site"}}}}, "coverage": []any{nil, []Object{{"id": ModuleIDs()[0], "state": "covered", "reasonCodes": []string{}}}}, "point": []Object{{}, {"id": hash, "createdAt": "2026-10-28T00:00:00Z", "productionRestore": Object{"blockers": []string{}}}}, "policy": []Object{{}, {"retentionDays": 7}}, "log": []Object{{}, {"level": "error", "event": "not-known", "message": "private body", "component": "api", "at": "2026-10-28T00:00:00Z"}}}
	expected := jsFixture(t, input)
	actual := Object{}
	parsers := map[string]func(Object) (Object, error){"logs": func(v Object) (Object, error) { return ParseQuery("logs", v) }, "backups": func(v Object) (Object, error) { return ParseQuery("backups", v) }, "plans": func(v Object) (Object, error) { return ParseQuery("plans", v) }, "page": func(v Object) (Object, error) { return ParseQuery("page", v) }, "backup": ParseBackup, "create": ParseCreatePlan, "approve": func(v Object) (Object, error) { return ParsePlanCommand("approve", v) }, "execute": func(v Object) (Object, error) { return ParsePlanCommand("execute", v) }, "cancel": func(v Object) (Object, error) { return ParsePlanCommand("cancel", v) }, "native": ParseNativeCommand}
	for k, parse := range parsers {
		rows := []any{}
		for _, v := range list(input[k]) {
			r, e := parse(obj(v))
			if e != nil {
				rows = append(rows, nil)
			} else {
				rows = append(rows, r)
			}
		}
		actual[k] = rows
	}
	for k, f := range map[string]func(Object) Object{"overview": Overview, "point": Point, "policy": Policy, "log": Log, "plan": PlanProjection} {
		rows := []any{}
		for _, v := range list(input[k]) {
			rows = append(rows, f(obj(v)))
		}
		actual[k] = rows
	}
	rows := []any{}
	for _, v := range list(input["coverage"]) {
		rows = append(rows, Coverage(v))
	}
	actual["coverage"] = rows
	actual["digests"] = []any{}
	for k, v := range actual {
		if !reflect.DeepEqual(normalized(v), expected[k]) {
			a, _ := json.Marshal(v)
			e, _ := json.Marshal(expected[k])
			t.Errorf("%s\nGo %s\nJS %s", k, a, e)
		}
	}
}
