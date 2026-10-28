package contextdata

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalContextSchemasAndMaterialOrder(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	participant := "GUID0000000000000000000000000000"
	material := Object{"id": id, "label": "  Selected label  ", "mediaType": "text/plain", "content": "Chosen excerpt"}
	v1 := Object{"id": id, "assistanceId": id, "caseId": id, "participantId": participant, "scope": "  Selected scope  ", "scopeEventId": id, "expiresAt": 2000000100, "materials": []any{material}}
	v2 := Object{"schemaVersion": 2, "id": id, "taskId": id, "participationId": id, "participantId": participant, "scopeVersion": 1, "scopeEventId": id, "expiresAt": 2000000100, "materials": []any{material}}
	event := Object{"schemaVersion": 2, "id": id, "grantId": id, "taskId": id, "participationId": id, "scopeVersion": 1, "materialsHash": strings.Repeat("0", 64), "kind": "accept"}
	cases := []Object{{"payload": v1}, {"payload": v2, "v2": true}, {"payload": event, "v2": true, "event": true}}
	clone := func(v any) Object { var o Object; _ = json.Unmarshal(encode(v), &o); return o }
	unicode := clone(v2)
	unicode["materials"] = []any{Object{"id": id, "label": strings.Repeat("😀", 160), "mediaType": "text/plain", "content": strings.Repeat("😀", 4000)}}
	cases = append(cases, Object{"payload": unicode, "v2": true})
	unknown := clone(v2)
	unknown["modelAdded"] = true
	cases = append(cases, Object{"payload": unknown, "v2": true})
	duplicate := clone(v2)
	duplicate["materials"] = []any{material, material}
	cases = append(cases, Object{"payload": duplicate, "v2": true})
	badSecret := clone(v1)
	badSecret["materials"] = []any{Object{"id": id, "label": "Selected", "mediaType": "text/plain", "content": "password=😀😀😀😀"}}
	cases = append(cases, Object{"payload": badSecret})
	expected := list(node(t, "postgres://127.0.0.1:1/galaxy_go_test_context_schema", "schema", filepath.Join(t.TempDir(), "context-fixture.json"), cases)["values"])
	for i, c := range cases {
		var p *ordered
		var e error
		if c["event"] == true {
			p, e = parseEvent(string(encode(c["payload"])), c["v2"] == true)
		} else {
			p, e = parseGrant(string(encode(c["payload"])), c["v2"] == true)
		}
		want := obj(expected[i])
		if e != nil {
			if want["error"] != true {
				t.Fatalf("schema%d Go=%v JS=%v", i, e, want)
			}
			continue
		}
		if want["error"] != nil {
			t.Fatalf("schema%d unexpected accept", i)
		}
		same(t, p, want["value"])
	}
}
