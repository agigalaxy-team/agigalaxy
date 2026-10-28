package searchv2

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestOriginalTypedSearchSchemas(t *testing.T) {
	subject := "GUID0000000000000000000000000000"
	id := "00000000-0000-4000-8000-000000000001"
	inputs := []Object{}
	for _, kind := range []string{"case", "history", "proof", "capsule", "task", "worker", "hub"} {
		inputs = append(inputs, Object{"value": Object{"type": kind, "query": Object{}}})
	}
	inputs = append(inputs, Object{"value": Object{"type": "opportunity", "query": Object{"context": Object{"kind": "ephemeral", "title": " Context ", "functions": []any{" Code "}}}}}, Object{"value": Object{"type": "opportunity", "query": Object{"context": Object{"kind": "project", "projectId": id}, "purposes": []any{"reuse", "reuse"}}}}, Object{"value": Object{"type": "history", "query": Object{"subjectId": nil}}}, Object{"value": Object{"type": "history", "query": Object{"subjectId": subject, "limit": 21}}}, Object{"value": Object{"type": "history", "query": Object{"query": strings.Repeat("x ", 9)}}}, Object{"value": Object{"type": "proof", "query": Object{"query": strings.Repeat("x ", 9)}}}, Object{"value": Object{"type": "worker", "query": Object{"type": "worker"}}}, Object{"value": Object{"type": "capsule", "query": Object{"query": "a b c d e f g h i"}}}, Object{"value": Object{"type": "task", "query": Object{"view": "requested", "limit": 20}}}, Object{"value": Object{"type": "opportunity", "query": Object{"context": Object{"kind": "ephemeral", "title": strings.Repeat("😀", 120), "functions": []any{"code"}}, "limit": 20}}}, Object{"reference": true, "value": Object{"search": Object{"type": "history", "query": Object{}}, "ref": Object{"id": id, "version": strings.Repeat("a", 64)}}})
	want := list(node(t, "postgres://127.0.0.1:1/galaxy_go_test_search_schema", "searchv2", "schema", filepath.Join(t.TempDir(), "history-fixture.json"), inputs)["values"])
	for i, input := range inputs {
		var value Object
		var e error
		if input["reference"] == true {
			value, e = ParseReference(encode(input["value"]))
		} else {
			value, e = ParseQuery(encode(input["value"]))
		}
		expected := obj(want[i])
		if e != nil {
			if expected["error"] != true {
				t.Fatalf("schema%d Go=%v JS=%v", i, e, expected)
			}
			continue
		}
		if expected["error"] != nil {
			t.Fatalf("schema%d unexpected success %s", i, encode(value))
		}
		same(t, value, expected["value"])
	}
}
