package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"math"
)

func a2aSafeInteger(value any) (int64, bool) {
	var n float64
	switch value := value.(type) {
	case int:
		return int64(value), int64(value) >= -9007199254740991 && int64(value) <= 9007199254740991
	case int64:
		return value, value >= -9007199254740991 && value <= 9007199254740991
	case float64:
		n = value
	case json.Number:
		var e error
		n, e = value.Float64()
		if e != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || math.Abs(n) > 9007199254740991 {
		return 0, false
	}
	return int64(n), true
}
func a2aInteger(value any) int64 { n, _ := a2aSafeInteger(value); return n }

func a2aFactWire(facts map[string]any) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for _, key := range []string{"version", "attemptRef", "origin", "taskId", "participationId", "scopeVersion", "participationScopeVersion"} {
		value := facts[key]
		if key == "attemptRef" || key == "origin" {
			v := uploadObject(value)
			ref := protocol.NewOrderedObject()
			if key == "origin" {
				ref.Set("kind", v["kind"])
			}
			ref.Set("id", v["id"])
			ref.Set("version", v["version"])
			value = ref
		}
		o.Set(key, value)
	}
	return o
}

// These readers must return current authenticated projections. Journal history
// and an external peer acknowledgement never grant present Case/Task access.
type a2aFactReaders struct {
	caseRead func(context.Context, string, map[string]any) (map[string]any, error)
	taskRead func(context.Context, string) (map[string]any, error)
}

func a2aLast(rows any, id, key string) map[string]any {
	var result map[string]any
	for _, row := range uploadRows(rows) {
		v := uploadObject(row)
		if text(v[key]) == id {
			result = v
		}
	}
	return result
}
func a2aNullable(v any) any {
	if v == nil {
		return nil
	}
	return v
}
func (r a2aFactReaders) resolve(ctx context.Context, caseID, attemptID, subject string, selected, frozen map[string]any) (map[string]any, map[string]any, error) {
	input := selected
	if frozen != nil {
		input = map[string]any{"attemptVersion": uploadObject(frozen["attemptRef"])["version"]}
		if frozen["taskId"] != nil {
			input["taskId"] = frozen["taskId"]
		}
		origin := uploadObject(frozen["origin"])
		if origin["kind"] == "intervention" {
			input["interventionRef"] = map[string]any{"id": origin["id"], "version": origin["version"]}
		}
	}
	if r.caseRead == nil || a2aInteger(input["attemptVersion"]) < 1 {
		return nil, nil, a2aError("explicit Attempt version required")
	}
	query := map[string]any{}
	if input["taskId"] != nil {
		query["taskId"] = input["taskId"]
	}
	current, e := r.caseRead(ctx, caseID, query)
	if e != nil {
		return nil, nil, e
	}
	if text(current["caseId"]) != caseID || a2aInteger(current["version"]) < 1 {
		return nil, nil, a2aError("Case unavailable")
	}
	a := a2aLast(current["attempts"], attemptID, "id")
	if a == nil || a2aInteger(a["version"]) != a2aInteger(input["attemptVersion"]) || text(a["actorId"]) != subject || a["provenance"] != "native-v2" || !connectionEqual(a["scopeVersion"], current["scopeVersion"]) {
		return nil, nil, a2aError("Attempt version, scope or actor changed")
	}
	if !connectionEqual(a2aNullable(a["taskId"]), a2aNullable(input["taskId"])) {
		return nil, nil, a2aError("explicit Task association required")
	}
	origin := a
	kind := "attempt"
	if ref := uploadObject(input["interventionRef"]); ref != nil {
		kind = "intervention"
		origin = a2aLast(current["interventions"], text(ref["id"]), "id")
		affects := false
		for _, v := range uploadRows(origin["affectsAttemptIds"]) {
			if text(v) == attemptID {
				affects = true
			}
		}
		if origin == nil || !affects || a2aInteger(origin["version"]) != a2aInteger(ref["version"]) || text(origin["actorId"]) != subject {
			return nil, nil, a2aError("selected Intervention must currently affect this Attempt")
		}
	}
	for _, key := range []string{"scopeVersion", "taskId", "participationId"} {
		if !connectionEqual(a2aNullable(origin[key]), a2aNullable(a[key])) {
			return nil, nil, a2aError("origin association mismatch")
		}
	}
	facts := map[string]any{"version": 2, "attemptRef": map[string]any{"id": a["id"], "version": a["version"]}, "origin": map[string]any{"kind": kind, "id": origin["id"], "version": origin["version"]}, "taskId": a2aNullable(a["taskId"]), "participationId": a2aNullable(a["participationId"]), "scopeVersion": a["scopeVersion"], "participationScopeVersion": a2aNullable(a["participationScopeVersion"])}
	if taskID := text(facts["taskId"]); taskID != "" {
		if r.taskRead == nil {
			return nil, nil, a2aError("Task reader required")
		}
		task, e := r.taskRead(ctx, taskID)
		if e != nil {
			return nil, nil, e
		}
		if text(task["taskId"]) != taskID || text(task["caseId"]) != caseID || task["paused"] == true || task["state"] == "canceled" || task["state"] == "closed" {
			return nil, nil, a2aError("Task unavailable")
		}
		if participation := text(facts["participationId"]); participation != "" {
			p := a2aLast(task["participations"], participation, "participationId")
			state := text(p["state"])
			if text(p["subjectId"]) != subject || p["scopeAvailable"] == false || !connectionEqual(p["scopeVersion"], facts["participationScopeVersion"]) || state != "active" && state != "delivered" && state != "accepted" && state != "disputed" {
				return nil, nil, a2aError("Participation unavailable")
			}
		} else if text(task["requesterId"]) != subject {
			return nil, nil, a2aError("requester or explicit Participation required")
		}
	}
	if frozen != nil && !connectionEqual(facts, frozen) {
		return nil, nil, a2aError("frozen fact association changed")
	}
	return current, facts, nil
}
