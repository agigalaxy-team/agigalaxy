package cases

import (
	"github.com/google/uuid"
	"path/filepath"
	"testing"
)

func TestOriginalFactSchemasAndTaskOperationHashes(t *testing.T) {
	id := uuid.NewString()
	subject := "GUID1234567890123456789012345678"
	base := Object{"kind": "attempt-start", "eventId": id, "caseId": uuid.NewString(), "expectedVersion": 1, "actorId": subject, "role": " author ", "strategy": "\ufeff approach \u0085 ", "inputScopeSummary": " input ", "permissionScope": []any{"read"}}
	changed := func(updates Object) Object {
		o := copyObject(base)
		for k, v := range updates {
			o[k] = v
		}
		return o
	}
	schemas := []any{base, changed(Object{"unknown": "reject"}), changed(Object{"configurationRef": nil}), changed(Object{"configurationRef": Object{"id": uuid.NewString(), "version": 1}}), changed(Object{"environment": nil}), changed(Object{"environment": Object{"name": "x", "version": "1", "extra": true}}), changed(Object{"scopeVersion": 1}), changed(Object{"expectedVersion": 9007199254740992}), changed(Object{"startedAt": "2033-05-18T03:33Z"}), changed(Object{"startedAt": "2033-05-18T03:33:20+00:00"}), changed(Object{"startedAt": "2033-02-29T03:33:20Z"}), changed(Object{"permissionScope": []any{}}), changed(Object{"strategy": "\u0085"})}
	root := Object{"kind": "case-created", "eventId": uuid.NewString(), "caseId": uuid.NewString(), "expectedVersion": 0, "actorId": subject, "localRef": "local:1", "title": " title ", "summary": " summary ", "source": Object{"kind": "active-task", "reference": "task:1"}, "synthetic": false}
	schemas = append(schemas, root)
	ref := Object{"id": id, "version": 1}
	for _, kind := range []string{"attempt-end", "attempt-correct", "intervention", "intervention-response", "result-recorded", "resolution-recorded", "case-scope-revised", "case-withdrawn"} {
		o := Object{"kind": kind, "eventId": uuid.NewString(), "caseId": base["caseId"], "expectedVersion": 1, "actorId": subject}
		switch kind {
		case "attempt-end", "attempt-correct":
			o["attemptRef"] = ref
			o["status"] = "inconclusive"
			o["summary"] = " summary "
			o["failureReason"] = " unknown "
			if kind == "attempt-correct" {
				o["reason"] = " correction "
			}
		case "intervention":
			o["types"] = []any{"advice"}
			o["affectsAttemptIds"] = []any{}
			o["description"] = " description "
			o["sourceRefs"] = []any{}
			o["observedEffect"] = " unknown "
		case "intervention-response":
			o["interventionRef"] = ref
			o["state"] = "accepted"
			o["summary"] = " reply "
		case "result-recorded":
			o["origin"] = Object{"kind": "attempt", "id": id, "version": 1}
			o["scopeVersion"] = 1
			o["deliverableRefs"] = []any{}
			o["reportedOutcome"] = "conflicting"
			o["summary"] = " result "
			o["limitations"] = " limits "
		case "resolution-recorded":
			o["taskScopeVersion"] = 1
			o["status"] = "regressed"
			o["summary"] = " reported "
			o["satisfiedGoals"] = []any{" goal "}
			o["remainingGoals"] = []any{}
			o["resultRefs"] = []any{ref}
			o["verificationRefs"] = []any{}
			o["supersedesResolutionId"] = nil
		case "case-scope-revised":
			o["taskScopeVersion"] = 2
			o["summary"] = " changed "
			o["reason"] = " reason "
		case "case-withdrawn":
			o["reason"] = " owner choice "
		}
		schemas = append(schemas, o)
	}
	link := Object{"initialFact": Object{"payloadJson": "{\"x\":\"\u2028\\u2028\"}", "consentId": uuid.NewString()}, "case": Object{"payloadJson": "{}", "consentId": uuid.NewString()}, "expectedTaskVersion": 1, "taskId": uuid.NewString(), "operationId": uuid.NewString()}
	oracle := node(t, "postgres://unused@127.0.0.1/galaxy_go_test_schema", "pure", filepath.Join(t.TempDir(), "case-fixture.json"), Object{"schemas": schemas, "rows": []any{}, "parent": Object{"id": id, "version": 1}, "link": link})
	expected := list(oracle["schemas"])
	for i, p := range schemas {
		got, e := parseFact(string(encode(p)))
		want := object(expected[i])
		if (e == nil) != (want["accepted"] == true) {
			t.Fatalf("schema %d Go=%v JS=%v input=%s", i, e, want, encode(p))
		}
		if e == nil {
			same(t, got, want["value"])
		}
	}
	current, legacy, e := linkHashes(link)
	if e != nil {
		t.Fatal(e)
	}
	same(t, Object{"current": current, "legacy": legacy}, oracle["hashes"])
}
