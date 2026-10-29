package experiencereviews

import (
	"bytes"
	"encoding/json"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalExperienceSchemaAndUTF16(t *testing.T) {
	base := Object{"id": "11111111-1111-4111-8111-111111111111", "operationId": "22222222-2222-4222-8222-222222222222", "expectedVersion": 0, "reportedBy": "GUID0000000000000000000000000000", "synthetic": false, "kind": "external-work", "subjectId": "GUID0000000000000000000000000000", "capabilityId": "code", "source": Object{"system": " System ", "stableRecord": " stable ", "originalAt": "2026-10-28T00:00:00Z", "originalAuthor": " Author ", "contentVersion": " 1 "}, "actualIntervention": " Intervention ", "resultReference": " Result ", "outcome": "partial", "scope": " Scope ", "limitations": []any{" Limitation "}, "ownershipStatement": " Ownership "}
	raw, _ := json.Marshal(base)
	inputs := []string{string(raw), strings.Replace(string(raw), `"scope":" Scope "`, `"scope":" \ud800 "`, 1), strings.Replace(string(raw), `"expectedVersion":0`, `"expectedVersion":0.0`, 1)}
	for _, modify := range []func(Object){func(p Object) { p["scope"] = strings.Repeat("😀", 801) }, func(p Object) { p["scope"] = "\ufeff\u0085\ufeff" }, func(p Object) { p["expectedVersion"] = 0.1 }, func(p Object) { p["unexpected"] = true }, func(p Object) { object(p["source"])["links"] = []any{"relative/path"} }, func(p Object) { object(p["source"])["links"] = []any{"javascript:alert(1)", "https://例子.测试/x"} }, func(p Object) { p["expiresAt"] = "2026-10-28T00:00:00+00:00" }} {
		copy := clone(base).(Object)
		modify(copy)
		b, _ := json.Marshal(copy)
		inputs = append(inputs, string(b))
	}
	root, _ := filepath.Abs("../../..")
	raw, _ = json.Marshal(inputs)
	script := `import {experienceEventSchema} from './packages/galaxy-contracts/src/experience-review-schema.mjs';let text='';for await(const c of process.stdin)text+=c;console.log(JSON.stringify(JSON.parse(text).map(raw=>{try{return{accepted:true,json:JSON.stringify(experienceEventSchema.parse(JSON.parse(raw)))}}catch{return{accepted:false}}})))`
	cmd := exec.Command("node", "--input-type=module", "-e", script)
	cmd.Dir = root
	cmd.Stdin = bytes.NewReader(raw)
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("current contract schemas: %v %s", e, out)
	}
	var expected []struct {
		Accepted bool
		JSON     string
	}
	if e = json.Unmarshal(out, &expected); e != nil {
		t.Fatal(e)
	}
	for i, raw := range inputs {
		got, e := ParseEvent([]byte(raw))
		if (e == nil) != expected[i].Accepted {
			t.Errorf("original schema acceptance differs at %d GoError=%v originalAccepted=%v", i, e, expected[i].Accepted)
			continue
		}
		if e != nil {
			continue
		}
		original, e := decodeValue([]byte(expected[i].JSON))
		if e != nil {
			t.Fatal(e)
		}
		a, _ := json.Marshal(got)
		b, _ := json.Marshal(original)
		if string(a) != string(b) {
			t.Errorf("original parsed value differs at %d Go=%s original=%s", i, a, b)
		}
	}
}
