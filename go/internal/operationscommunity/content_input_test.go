package operationscommunity

import (
	"bytes"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"os"
	"strings"
	"testing"
)

func TestOriginalContentSchemasAndUTF16Excerpt(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	cases := []Object{}
	add := func(k string, x Object) { cases = append(cases, Object{"kind": k, "input": x}) }
	for _, x := range []Object{{}, {"query": strings.Repeat("🚀", 160)}, {"query": strings.Repeat("🚀", 161)}, {"after": "POST:" + id}, {"after": nil}, {"pinned": false}, {"days": 28}, {"days": "all"}, {"days": "7"}, {"limit": 101}} {
		add("contentQuery", x)
	}
	for _, name := range []string{"", "\ufeff Ｏriginal  标签 \ufeff", strings.Repeat("🚀", 40), strings.Repeat("🚀", 41), "原\u0085标签"} {
		add("tagCreate", Object{"operationId": id, "name": name})
	}
	for _, v := range []any{nil, false, true} {
		add("tagUpdate", Object{"operationId": id, "expectedVersion": 1, "enabled": v})
	}
	for _, v := range []any{nil, false, []any{}, []any{id}, []any{id, id}} {
		x := Object{"operationId": id, "expectedVersion": 1, "expectedRevision": 0, "reason": "原编排说明", "tagIds": v}
		add("curation", x)
	}
	for _, kind := range []string{"hide", "restore"} {
		for _, until := range []any{nil, 2000000100} {
			x := Object{"operationId": id, "expectedVersion": 1, "expectedRevision": 0, "reason": "原说明", "kind": kind}
			if until != nil {
				x["until"] = until
			}
			add("contentVisibility", x)
		}
	}
	for _, k := range []string{"batch", "preview"} {
		for _, duplicate := range []bool{false, true} {
			item := Object{"kind": "post", "id": id, "expectedVersion": 1, "expectedRevision": 0}
			items := []any{item}
			if duplicate {
				items = append(items, item)
			}
			x := Object{"kind": "restore", "items": items}
			if k == "batch" {
				x["operationId"], x["reason"] = id, "原批量说明"
			}
			add(k, x)
		}
	}
	b, e := os.ReadFile("testdata/original-content-schema.json")
	if e != nil {
		t.Fatal(e)
	}
	var want []Object
	if e = json.Unmarshal(b, &want); e != nil {
		t.Fatal(e)
	}
	for i, c := range cases {
		var got Object
		var err error
		switch str(c, "kind") {
		case "contentQuery":
			got, err = parseContentQuery(obj(c, "input"))
		case "tagCreate", "tagUpdate":
			got, err = parseTag(obj(c, "input"), str(c, "kind") == "tagCreate")
		case "curation":
			got, err = parseContentWrite(obj(c, "input"), "curation")
		case "contentVisibility":
			got, err = parseContentWrite(obj(c, "input"), "visibility")
		default:
			got, err = parseBatch(obj(c, "input"), str(c, "kind") == "preview")
		}
		if (err == nil) != yes(want[i], "accepted") {
			t.Fatalf("case%d %v Goerr%v JS%v", i, c, err, want[i])
		}
		if err == nil {
			x, _ := identity.Canonical(got)
			y, _ := identity.Canonical(want[i]["value"])
			if !bytes.Equal(x, y) {
				t.Fatalf("case%d%s !=%s", i, x, y)
			}
		}
	}
	source := strings.Repeat("a", 179) + "🚀tail"
	raw := encode(jsSlice(source, 180))
	expected := []byte("\"" + strings.Repeat("a", 179) + `\ud83d"`)
	if !bytes.Equal(raw, expected) {
		t.Fatalf("UTF16 excerpt %s != %s", raw, expected)
	}
}
