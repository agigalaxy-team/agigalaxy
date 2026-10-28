package taskmaterials

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrepareOriginalRequiredFieldsAndNumberSemantics(t *testing.T) {
	base := `{"source":{"postId":"11111111-1111-4111-8111-111111111111","versionId":"22222222-2222-4222-8222-222222222222"},"selections":[{"materialId":"33333333-3333-4333-8333-333333333333","field":"body","start":0,"end":1}],"expiresAt":1}`
	inputs := []string{base, strings.Replace(base, `"start":0,`, "", 1), strings.Replace(base, `"start":0`, `"start":0.0`, 1), strings.Replace(base, `"end":1`, `"end":1e0`, 1), strings.Replace(base, `"end":1`, `"end":1.1`, 1), strings.Replace(base, `"expiresAt":1`, `"expiresAt":9007199254740992`, 1), strings.Replace(base, `"field":"body"`, `"field":"body","extra":true`, 1), strings.Replace(base, `"end":1`, `"end":1,"text":" "`, 1), strings.Replace(base, `"end":1`, `"end":1,"text":null`, 1)}
	cases := []Object{}
	for _, input := range inputs {
		cases = append(cases, Object{"kind": "prepare", "json": input})
	}
	root, _ := filepath.Abs("../../..")
	file := filepath.Join(t.TempDir(), "schemas.json")
	raw, _ := json.Marshal(cases)
	if e := os.WriteFile(file, raw, 0600); e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/task-materials-interop.mjs"), "schemas", file)
	cmd.Dir = root
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original prepare schema: %v %s", e, out)
	}
	var expected []struct {
		Accepted bool
		Value    Object
	}
	if e = json.Unmarshal(out, &expected); e != nil {
		t.Fatal(e)
	}
	for i, input := range inputs {
		actual, e := ParsePrepare([]byte(input))
		if (e == nil) != expected[i].Accepted {
			t.Errorf("original prepare acceptance differs at %d", i)
		}
		if e == nil {
			var value Object
			_ = json.Unmarshal(jsonBytes(actual), &value)
			equalJSON(t, value, expected[i].Value, "prepare normalized value")
		}
	}
	state := SourceState{Payload: Object{"body": "A😀B"}}
	selected, e := selection(state, Object{"field": "body", "start": 1, "end": 2})
	if e != nil || selected != "😀" {
		t.Fatal("original codepoint selection changed", e)
	}
}
