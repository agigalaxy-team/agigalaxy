package taskmaterials

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestPrepareOriginalRequiredFieldsAndNumberSemantics(t *testing.T) {
	base := `{"source":{"postId":"11111111-1111-4111-8111-111111111111","versionId":"22222222-2222-4222-8222-222222222222"},"selections":[{"materialId":"33333333-3333-4333-8333-333333333333","field":"body","start":0,"end":1}],"expiresAt":1}`
	inputs := []string{base, strings.Replace(base, `"start":0,`, "", 1), strings.Replace(base, `"start":0`, `"start":0.0`, 1), strings.Replace(base, `"end":1`, `"end":1e0`, 1), strings.Replace(base, `"end":1`, `"end":1.1`, 1), strings.Replace(base, `"expiresAt":1`, `"expiresAt":9007199254740992`, 1), strings.Replace(base, `"field":"body"`, `"field":"body","extra":true`, 1), strings.Replace(base, `"end":1`, `"end":1,"text":" "`, 1), strings.Replace(base, `"end":1`, `"end":1,"text":null`, 1)}
	out, e := os.ReadFile("testdata/prepare-original.json")
	if e != nil {
		t.Fatal(e)
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
