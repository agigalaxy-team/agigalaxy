package publication

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotSchemaMatchesOriginalJSBoundaries(t *testing.T) {
	_, _, snapshot, _, configPath := fixtureFiles(t)
	raw, _ := json.Marshal(snapshot)
	clone := func() Object { var v Object; json.Unmarshal(raw, &v); return v }
	values := []Object{clone()}
	v := clone()
	v["pages"].([]any)[0].(map[string]any)["path"] = "/admin/"
	values = append(values, v)
	v = clone()
	v["pages"].([]any)[0].(map[string]any)["blocks"].([]any)[0].(map[string]any)["draft"] = true
	values = append(values, v)
	v = clone()
	v["media"] = []any{}
	values = append(values, v)
	v = clone()
	v["settings"].(map[string]any)["footerLinks"].([]any)[0].(map[string]any)["href"] = "javascript:alert(1)"
	values = append(values, v)
	v = clone()
	v["settings"].(map[string]any)["description"] = nil
	values = append(values, v)
	v = clone()
	v["media"].([]any)[0].(map[string]any)["filename"] = "../draft.png"
	values = append(values, v)
	v = clone()
	v["media"].([]any)[0].(map[string]any)["width"] = nil
	values = append(values, v)
	v = clone()
	v["pages"] = append(v["pages"].([]any), v["pages"].([]any)[0])
	values = append(values, v)
	v = clone()
	delete(v, "settings")
	values = append(values, v)
	v = clone()
	v["pages"].([]any)[0].(map[string]any)["blocks"] = []any{map[string]any{"blockType": "notice", "tone": "service-impact", "title": "服务通知", "text": "正在维护"}, map[string]any{"blockType": "releaseLinks", "channel": "stable", "label": "下载"}, map[string]any{"blockType": "hero", "heading": "指南", "text": "说明", "links": []any{}}, map[string]any{"blockType": "linkList", "links": []any{}}}
	values = append(values, v)
	for _, stamp := range []string{"2026-10-28T00:00Z", "2026-10-28T00:00:00,1Z", "2026-10-28T00:00:00+08:00", "2026-02-30T00:00:00Z"} {
		v := clone()
		v["pages"].([]any)[0].(map[string]any)["updatedAt"] = stamp
		values = append(values, v)
	}
	path := filepath.Join(filepath.Dir(configPath), "schema-corpus.json")
	b, _ := json.Marshal(values)
	if e := os.WriteFile(path, b, 0600); e != nil {
		t.Fatal(e)
	}
	var original []bool
	if e := json.Unmarshal(node(t, "", "validate", path), &original); e != nil {
		t.Fatal(e)
	}
	for i, value := range values {
		b, _ := json.Marshal(value)
		_, e := ParseSnapshot(b)
		if (e == nil) != original[i] {
			t.Fatalf("snapshot boundary %d differs from current original JS: Go=%v JS=%v", i, e, original[i])
		}
	}
}
