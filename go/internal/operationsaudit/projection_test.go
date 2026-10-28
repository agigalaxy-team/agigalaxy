package operationsaudit

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const sampleUUID = "00000000-0000-4000-8000-000000000001"

func sample(schema Object) any {
	if types, ok := schema["type"].([]any); ok {
		one := Object{}
		for k, v := range schema {
			one[k] = v
		}
		one["type"] = types[0]
		return sample(one)
	}
	if all, ok := schema["anyOf"].([]any); ok {
		return sample(obj(all[0]))
	}
	if value, ok := schema["const"]; ok {
		return value
	}
	switch schema["type"] {
	case "null":
		return nil
	case "boolean":
		return true
	case "integer", "number":
		if min, ok := numeric(schema["exclusiveMinimum"]); ok {
			return min + 1
		}
		if min, ok := numeric(schema["minimum"]); ok {
			return min
		}
		return 1
	case "string":
		switch schema["format"] {
		case "uuid":
			return sampleUUID
		case "date-time":
			return "2033-05-18T03:33:20.000Z"
		case "date":
			return "2033-05-18"
		}
		pattern := str(schema["pattern"])
		if strings.Contains(pattern, "GUID") {
			return "GUID" + strings.Repeat("A", 28)
		}
		if strings.Contains(pattern, "{64}") {
			return strings.Repeat("a", 64)
		}
		if strings.Contains(pattern, "[1-9]") {
			return "1"
		}
		if strings.Contains(pattern, "(post|reply)") {
			return "post:" + sampleUUID
		}
		if strings.Contains(pattern, "(chat|forum)") {
			return "chat:" + sampleUUID
		}
		if n, _ := numeric(schema["maxLength"]); n == 512 {
			return `["available",1,null,null,true,null,null,null,0]`
		}
		return "Synthetic permitted text"
	case "array":
		return []any{sample(obj(schema["items"]))}
	case "object":
		o := Object{}
		for key, child := range obj(schema["properties"]) {
			o[key] = sample(obj(child))
		}
		return o
	}
	return nil
}
func fixtureRow(action string) Object {
	return Object{"id": sampleUUID, "sequence": "12", "endpoint": "https://audit.example.invalid", "operator_id": strings.Repeat("a", 64), "operator_display_name": " Synthetic operator ", "operator_role": "reader", "action": action, "actor_kind": "business-operator", "execution_id": nil, "grant_id": nil, "account_id": nil, "operation_id": sampleUUID, "http_request_id": nil, "created_at": "2033-05-18T03:33:20.000Z"}
}
func TestAllOriginalClosedAuditActionProjectionsAndCustomRefinements(t *testing.T) {
	rows := []Object{}
	for action, entry := range catalog.Actions {
		row := fixtureRow(action)
		for _, side := range []string{"selection", "result"} {
			v := Object{"rawSecret": "synthetic unknown prose must not escape"}
			for key, index := range entry[side] {
				v[key] = sample(catalog.Types[index])
			}
			row[side] = v
		}
		rows = append(rows, row)
		dirty := fixtureRow(action)
		for _, side := range []string{"selection", "result"} {
			v := Object{}
			for key := range entry[side] {
				v[key] = Object{"unexpected": "synthetic"}
			}
			dirty[side] = v
		}
		rows = append(rows, dirty)
	}
	for _, version := range []any{1, `["available",1,null,null,true,null,null,null,0]`, `["available",1,null,null,true,null,null,null]`, `["available",1,null,null,true,null,null,null,9007199254740992]`, "arbitrary prose"} {
		r := fixtureRow("file-retry")
		r["selection"] = Object{"command": Object{"operationId": sampleUUID, "kind": "scan", "expectedVersion": version}}
		rows = append(rows, r)
	}
	for _, day := range []string{"2033-05-18", "0000-01-01", "2033-02-29", "2032-02-29"} {
		r := fixtureRow("audit-read")
		r["selection"] = Object{"day": day}
		rows = append(rows, r)
	}
	unknown := fixtureRow("unregistered-historical-action")
	unknown["selection"] = Object{"title": "synthetic private narrative"}
	unknown["result"] = Object{"body": "synthetic body"}
	rows = append(rows, unknown)
	raw, _ := json.Marshal(rows)
	root, _ := filepath.Abs("../../..")
	cmd := exec.Command("node", filepath.Join(root, "go/internal/operationsaudit/testdata/oracle.mjs"))
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(raw)
	output, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original audit projection %v %s", e, output)
	}
	var expected []Object
	if json.Unmarshal(output, &expected) != nil {
		t.Fatalf("invalid original projection %s", output)
	}
	for i, row := range rows {
		got := Metadata(row)
		wire, _ := json.Marshal(got)
		var normalized Object
		_ = json.Unmarshal(wire, &normalized)
		if !reflect.DeepEqual(normalized, expected[i]) {
			t.Fatalf("audit action %s differs Go=%s JS=%s", row["action"], wire, mustJSON(expected[i]))
		}
	}
}
func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
