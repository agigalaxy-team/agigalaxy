package operationsautonomy

import (
	"encoding/json"
	"github.com/google/uuid"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOriginalWorkbenchTrustedFactProjections(t *testing.T) {
	runs := []any{}
	for _, status := range []string{"PENDING", "RUNNING", "COMPLETED", "PAUSED", "ERROR", "CANCELLED", "UNKNOWN"} {
		runs = append(runs, Object{"runId": "original-run", "status": status, "usage": Object{"calls": 2, "inputTokens": 3, "outputTokens": 4, "totalTokens": 7, "durationMs": 2.5}})
	}
	runs = append(runs, Object{}, Object{"metrics": Object{"calls": 1.5, "inputTokens": -1, "outputTokens": 9007199254740992.0, "totalTokens": "untrusted", "durationMs": 2.5}})
	operationID, targetID := uuid.NewString(), uuid.NewString()
	proposal := Object{"kind": "feedback-update", "target": Object{"kind": "feedback", "id": targetID}, "request": Object{}}
	cards := []any{Object{"state": "prepared"}, Object{"state": "processing"}, Object{"state": "not-available", "result": Object{"state": "cancelled"}}}
	for _, state := range []string{"completed", "unknown", "failed"} {
		cards = append(cards, Object{"state": state, "operation_id": operationID, "proposal": proposal, "result": Object{"operationId": operationID, "state": "completed", "receipt": Object{"private": "not copied"}}})
	}
	cards = append(cards, Object{"state": "completed", "operation_id": operationID, "proposal": proposal, "result": Object{"operationId": uuid.NewString(), "state": "completed", "receipt": Object{}}})
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
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/operations-autonomy-interop.mjs"), "facts")
	cmd.Dir = root
	cmd.Stdin = strings.NewReader(jsonText(Object{"runs": runs, "cards": cards}))
	out, e := cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original facts %v %s", e, out)
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
