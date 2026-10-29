package operationsautonomy

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func TestOriginalWorkbenchTrustedFactProjections(t *testing.T) {
	runs := []any{}
	for _, status := range []string{"PENDING", "RUNNING", "COMPLETED", "PAUSED", "ERROR", "CANCELLED", "UNKNOWN"} {
		runs = append(runs, Object{"runId": "original-run", "status": status, "usage": Object{"calls": 2, "inputTokens": 3, "outputTokens": 4, "totalTokens": 7, "durationMs": 2.5}})
	}
	runs = append(runs, Object{}, Object{"metrics": Object{"calls": 1.5, "inputTokens": -1, "outputTokens": 9007199254740992.0, "totalTokens": "untrusted", "durationMs": 2.5}})
	operationID, targetID := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	proposal := Object{"kind": "feedback-update", "target": Object{"kind": "feedback", "id": targetID}, "request": Object{}}
	cards := []any{Object{"state": "prepared"}, Object{"state": "processing"}, Object{"state": "not-available", "result": Object{"state": "cancelled"}}}
	for _, state := range []string{"completed", "unknown", "failed"} {
		cards = append(cards, Object{"state": state, "operation_id": operationID, "proposal": proposal, "result": Object{"operationId": operationID, "state": "completed", "receipt": Object{"private": "not copied"}}})
	}
	cards = append(cards, Object{"state": "completed", "operation_id": operationID, "proposal": proposal, "result": Object{"operationId": "33333333-3333-4333-8333-333333333333", "state": "completed", "receipt": Object{}}})
	receipt := Object{"counts": Object{"applied": 1, "rejected": 0}, "items": []any{Object{"kind": "post", "id": targetID, "status": "applied", "code": nil, "revision": 3, "private": "excluded"}}, "private": "excluded"}
	for _, kind := range []string{"valid", "wrong-count", "duplicate", "missing-code"} {
		r := obj(clone(receipt))
		switch kind {
		case "wrong-count":
			obj(r["counts"])["applied"] = 2
		case "duplicate":
			r["items"] = append(list(r["items"]), list(r["items"])[0])
		case "missing-code":
			delete(obj(list(r["items"])[0]), "code")
		}
		cards = append(cards, Object{"state": "completed", "operationId": operationID, "proposal": Object{"kind": "public-content-batch"}, "result": Object{"operationId": operationID, "state": "completed", "receipt": r}})
	}
	out, e := os.ReadFile("testdata/original-facts.json")
	if e != nil {
		t.Fatal(e)
	}
	var expected Object
	if json.Unmarshal(out, &expected) != nil {
		t.Fatal("invalid original facts")
	}
	goRuns, goCards := []any{}, []any{}
	for _, v := range runs {
		goRuns = append(goRuns, WorkbenchRunFact(obj(v)))
	}
	for _, v := range cards {
		fact := WorkbenchCardFact(obj(v))
		if fact == nil {
			goCards = append(goCards, nil)
		} else {
			goCards = append(goCards, fact)
		}
	}
	actual := Object{"runs": goRuns, "cards": goCards}
	var normalized Object
	json.Unmarshal([]byte(jsonText(actual)), &normalized)
	if !reflect.DeepEqual(normalized, expected) {
		t.Fatalf("fact projections\nGo%s\nJS%s", jsonText(actual), jsonText(expected))
	}
}
