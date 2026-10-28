package taskmaterials

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func orderedMap(v any) Object {
	switch x := v.(type) {
	case *protocol.OrderedObject:
		return x.Values()
	case map[string]any:
		return x
	}
	return nil
}
func historyArray(v any) []any {
	switch x := v.(type) {
	case []any:
		return x
	case []Object:
		out := []any{}
		for _, v := range x {
			out = append(out, v)
		}
		return out
	}
	return nil
}
func historyElementID(v any) string {
	o := orderedMap(v)
	if event := orderedMap(o["event"]); event != nil {
		return str(event, "eventId")
	}
	for _, key := range []string{"deliveryId", "eventId", "participationId", "id"} {
		if id := str(o, key); id != "" {
			return id
		}
	}
	return ""
}

// Keep only the already-authorized values. The retained snapshot supplies
// member order, never permission or an alternative source body.
func historyOrder(value, source any) any {
	if values := orderedMap(value); values != nil {
		ordered, ok := source.(*protocol.OrderedObject)
		if !ok {
			return value
		}
		out := protocol.NewOrderedObject()
		seen := map[string]bool{}
		for _, key := range ordered.Keys() {
			if current, ok := values[key]; ok {
				out.Set(key, historyOrder(current, ordered.Values()[key]))
				seen[key] = true
			}
		}
		remaining := []string{}
		for key := range values {
			if !seen[key] {
				remaining = append(remaining, key)
			}
		}
		sort.Strings(remaining)
		for _, key := range remaining {
			out.Set(key, values[key])
		}
		return out
	}
	if values := historyArray(value); values != nil {
		old := historyArray(source)
		out := []any{}
		for i, current := range values {
			var original any
			id := historyElementID(current)
			if id != "" {
				for _, candidate := range old {
					if historyElementID(candidate) == id {
						original = candidate
						break
					}
				}
			} else if i < len(old) {
				original = old[i]
			}
			out = append(out, historyOrder(current, original))
		}
		return out
	}
	return value
}
func historyTextField(value Object) *protocol.OrderedObject {
	segments := []any{}
	for _, raw := range historyArray(value["segments"]) {
		segment := raw.(map[string]any)
		out := taskOrdered("kind", segment["kind"])
		if segment["kind"] == "literal" {
			out.Set("text", segment["text"])
		} else {
			out.Set("materialId", segment["materialId"])
			out.Set("status", segment["status"])
			if text, ok := segment["text"]; ok {
				out.Set("text", text)
			}
		}
		segments = append(segments, out)
	}
	out := taskOrdered("state", value["state"], "text", value["text"], "segments", segments, "checkedAt", value["checkedAt"])
	if until, ok := value["availableUntil"]; ok {
		out.Set("availableUntil", until)
	}
	return out
}

// ReadHistoryWireWithin is the original History consumer's ordered Task subset.
// Source permission is exclusively ReadTaskWithin; raw retained snapshots below
// restore JSON.stringify member order only after that projection succeeds.
func (s *Service) ReadHistoryWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (json.RawMessage, error) {
	view, e := s.ReadTaskWithin(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	request := obj(view, "request")
	wireRequest := taskOrdered("title", request["title"], "summary", request["summary"])
	if capability, ok := request["capabilityId"]; ok {
		wireRequest.Set("capabilityId", capability)
	}
	out := taskOrdered("requesterId", view["requesterId"], "caseId", view["caseId"], "request", wireRequest)
	if textView := obj(view, "textView"); textView != nil {
		fields := obj(textView, "fields")
		out.Set("textView", taskOrdered("format", textView["format"], "checkedAt", textView["checkedAt"], "fields", taskOrdered("title", historyTextField(obj(fields, "title")), "summary", historyTextField(obj(fields, "summary")))))
	}
	parts := []any{}
	for _, rawPart := range historyArray(view["participations"]) {
		p := rawPart.(map[string]any)
		var retained string
		if e = tx.QueryRow(ctx, "SELECT snapshot::text FROM task_participations WHERE id=$1 AND task_id=$2", p["participationId"], id).Scan(&retained); e != nil {
			return nil, e
		}
		original, e := protocol.DecodeOrdered([]byte(retained))
		if e != nil {
			return nil, fail("task_history_integrity_error", 500)
		}
		ordered := historyOrder(p, original)
		values := orderedMap(ordered)
		part := taskOrdered("subjectId", values["subjectId"], "participationId", values["participationId"], "role", values["role"])
		if scope, ok := values["scopeAvailable"]; ok {
			part.Set("scopeAvailable", scope)
		}
		for _, key := range []string{"agreedScope", "scopeVersion", "events", "deliveries"} {
			part.Set(key, values[key])
		}
		parts = append(parts, part)
	}
	out.Set("participations", parts)
	raw, e := protocol.EncodeJS(out)
	return json.RawMessage(raw), e
}
