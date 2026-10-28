package verificationrecords

import (
	"encoding/json"
	"github.com/google/uuid"
	"path/filepath"
	"testing"
)

func TestOriginalRecordSchemaNormalizationAndStrictFields(t *testing.T) {
	id := uuid.NewString()
	base := Object{"kind": "evidence", "id": id, "operationId": uuid.NewString(), "expectedVersion": 0, "caseId": uuid.NewString(), "reportedBy": "GUID1234567890123456789012345678", "synthetic": false, "evidenceType": "test-result", "source": Object{"originSystem": "  fixture  ", "externalStableId": " stable ", "contentVersion": " 1 ", "originalAt": "2033-05-18T03:33:20Z", "issuer": "  author  ", "uri": "mailto:fixture@example.invalid"}, "observedAt": "2033-05-18T03:33:20.123Z", "reportedSourceState": "unknown", "summary": "\ufeff summary \u0085 ", "expiresAt": nil}
	clone := func(v Object) Object { var out Object; _ = json.Unmarshal(encode(v), &out); return out }
	change := func(fields Object) Object {
		o := clone(base)
		for k, v := range fields {
			o[k] = v
		}
		return o
	}
	vectors := []any{base, change(Object{"unknown": true}), change(Object{"taskId": nil, "participationId": nil}), change(Object{"reason": nil}), change(Object{"expectedVersion": 1000}), change(Object{"expectedVersion": -1}), change(Object{"synthetic": nil}), change(Object{"source": Object{"originSystem": "x", "externalStableId": "y", "contentVersion": "z", "originalAt": "2033-05-18T03:33Z", "issuer": "author"}}), change(Object{"source": Object{"originSystem": "x", "externalStableId": "y", "contentVersion": "z", "originalAt": "2033-05-18T03:33:20Z", "issuer": "author", "extra": "rejected"}})}
	verification := Object{"kind": "verification", "id": uuid.NewString(), "operationId": uuid.NewString(), "expectedVersion": 0, "caseId": base["caseId"], "reportedBy": base["reportedBy"], "synthetic": true, "target": Object{"type": "result", "id": id, "version": 1}, "scopeVersion": 1, "method": "participant-feedback", "scope": " report ", "conditions": Object{"number": 1.5, "switch": true, "text": " keep ", "big": 1e100}, "observation": "accepted", "summary": " summary ", "evidenceRefs": []any{}, "relationship": "unknown", "observedAt": base["observedAt"]}
	vectors = append(vectors, verification)
	bad := clone(verification)
	bad["conditions"] = Object{"nested": Object{}}
	vectors = append(vectors, bad)
	bad = clone(verification)
	bad["target"] = Object{"type": "attempt", "id": id, "version": 0}
	vectors = append(vectors, bad)
	revoke := Object{"kind": "revoke", "id": id, "operationId": uuid.NewString(), "expectedVersion": 1, "caseId": base["caseId"], "reportedBy": base["reportedBy"], "synthetic": true, "objectType": "evidence", "reason": " owner choice "}
	vectors = append(vectors, revoke)
	expected := arr(node(t, "postgres://unused@127.0.0.1/galaxy_go_test_schema", "schema", filepath.Join(t.TempDir(), "verification-fixture.json"), vectors)["values"])
	for i, v := range vectors {
		got, e := parseRecord(string(encode(v)))
		want := obj(expected[i])
		if (e == nil) != (want["accepted"] == true) {
			t.Fatalf("schema %d Go=%v JS=%v input=%s", i, e, want, encode(v))
		}
		if e == nil {
			same(t, got, want["value"])
		}
	}
}
