package operationsrules

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"os"
	"strings"
	"testing"
)

func TestRulesOriginalSchemaAndDetailedEvaluation(t *testing.T) {
	listID, ruleID, exceptionID, accountID := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"
	policy := EmptyControls()
	policy["lists"] = []any{Object{"id": listID, "name": "Unicode名单", "kind": "keyword", "enabled": true, "entries": []any{"ＡＢＣ", "😀"}}}
	policy["rules"] = []any{Object{"id": ruleID, "name": "样本规则", "enabled": true, "targets": []any{"forum-post"}, "conditions": Object{"combinator": "or", "rules": []any{Object{"field": "keywordList", "operator": "matches", "value": listID}, Object{"field": "textLength", "operator": "gt", "value": 20}}}, "action": "reject", "exceptions": []any{Object{"id": exceptionID, "name": "账户例外", "enabled": true, "accountIds": []any{accountID}}}}}
	copyPolicy := func() Object {
		raw, _ := json.Marshal(policy)
		var out Object
		_ = json.Unmarshal(raw, &out)
		return out
	}
	variants := []any{policy, EmptyControls()}
	duplicate := copyPolicy()
	obj(list(duplicate["lists"])[0])["entries"] = []any{"ＡＢＣ", "abc"}
	variants = append(variants, duplicate)
	astral := copyPolicy()
	obj(list(astral["rules"])[0])["name"] = strings.Repeat("😀", 80)
	variants = append(variants, astral)
	tooLong := copyPolicy()
	obj(list(tooLong["rules"])[0])["name"] = strings.Repeat("😀", 81)
	variants = append(variants, tooLong)
	upload := copyPolicy()
	obj(list(upload["rules"])[0])["targets"] = []any{"forum-upload"}
	variants = append(variants, upload)
	control := copyPolicy()
	obj(list(control["rules"])[0])["name"] = "hidden\u0085name"
	variants = append(variants, control)
	evaluations := []any{}
	for _, facts := range []Object{{"target": "forum-post", "text": "abc", "links": []any{}}, {"target": "forum-post", "text": "abc", "links": []any{}, "accountId": accountID}, {"target": "forum-post", "links": []any{}}, {"target": "forum-post", "text": "no hit", "links": []any{}, "accountId": accountID}, {"target": "forum-upload", "fileBytes": 32}} {
		evaluations = append(evaluations, Object{"policy": policy, "facts": facts})
	}
	raw, e := os.ReadFile("testdata/rules-schema.json")
	if e != nil {
		t.Fatal(e)
	}
	var source Object
	if e = json.Unmarshal(raw, &source); e != nil {
		t.Fatal(e)
	}
	for i, value := range variants {
		got, e := ParseControls(obj(value))
		expected := list(source["business-controls"])[i]
		if e != nil {
			if expected != nil {
				t.Fatalf("original accepts variant %d", i)
			}
		} else if !same(got, expected) {
			t.Fatalf("schema variant %d %#v %#v", i, got, expected)
		}
	}
	normalized, e := ParseControls(policy)
	if e != nil {
		t.Fatal(e)
	}
	for i, v := range evaluations {
		got, e := businessrules.EvaluateDetailed(normalized, obj(obj(v)["facts"]))
		if e != nil || !same(got, list(source["evaluations"])[i]) {
			t.Fatalf("detailed sample %d %#v %#v %v", i, got, list(source["evaluations"])[i], e)
		}
	}
}
