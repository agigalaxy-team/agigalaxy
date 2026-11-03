package operationsautonomy

import "testing"

func TestQuerySourceProofRequiresActualMaterialReferences(t *testing.T) {
	read := Object{"tool": "query-operations", "arguments": Object{"module": "feedback", "view": "list"}}
	snapshot := Object{"kind": "operations-query", "id": "feedback:list", "controlledSource": false, "read": read, "label": "do not store"}
	item := Object{"kind": "feedback", "id": "one", "controlledSource": true, "version": 1, "read": read, "label": "private"}
	cases := []struct {
		name     string
		result   Object
		complete bool
		material string
	}{
		{"no data", Object{"data": nil, "evidenceRefs": []any{}}, true, "none"},
		{"partial data without refs", Object{"data": Object{"items": []any{Object{"id": "one"}}}, "evidenceRefs": []any{}}, false, "present"},
		{"snapshot does not prove row", Object{"data": Object{"items": []any{Object{"id": "one"}}}, "evidenceRefs": []any{snapshot}}, false, "present"},
		{"row proof", Object{"data": Object{"items": []any{Object{"id": "one"}}}, "evidenceRefs": []any{snapshot, item}}, true, "present"},
		{"empty page", Object{"data": Object{"items": []any{}}, "evidenceRefs": []any{snapshot}}, true, "present"},
		{"authorized collection without object IDs", Object{"evidenceScope": "collection", "data": Object{"items": []any{Object{"event": "worker-started"}}}, "evidenceRefs": []any{snapshot}}, true, "present"},
		{"collection cannot hide controlled objects", Object{"evidenceScope": "collection", "data": Object{"items": []any{Object{"id": "one"}}}, "evidenceRefs": []any{snapshot, item}}, false, "present"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			proof := querySourceProof(tc.result)
			if proof["complete"] != tc.complete || proof["material"] != tc.material {
				t.Fatalf("proof: %#v", proof)
			}
			for _, v := range proof["refs"].([]any) {
				if _, ok := obj(v)["label"]; ok {
					t.Fatal("presentation data persisted")
				}
			}
		})
	}
}
