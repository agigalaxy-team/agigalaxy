package taskmaterials

import (
	"context"
	"encoding/json"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

// ReadChoiceWireWithin preserves the full current Task record, omitting only
// the original Choice consumer's aggregate version and private interaction DTOs.
func (s *Service) ReadChoiceWireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (json.RawMessage, error) {
	item, e := s.ReadTaskWithin(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	raw, e := s.queryTasksWireWithin(ctx, tx, []Object{item}, nil)
	if e != nil {
		return nil, e
	}
	value, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	page := value.(*protocol.OrderedObject).Values()
	current := page["items"].([]any)[0].(*protocol.OrderedObject)
	current.Delete("version")
	raw, e = protocol.EncodeJS(current)
	return json.RawMessage(raw), e
}

// QueryTasksWire is the full original query DTO consumed by Search. Selection,
// source permission and pagination are the same real query in the same tx;
// retained JSON restores member order only, never source content or authority.
func (s *Service) QueryTasksWire(ctx context.Context, a *Actor, view, query, after string, limit int) (json.RawMessage, error) {
	value, e := s.queryTasks(ctx, a, view, query, after, limit, true)
	if e != nil {
		return nil, e
	}
	return value.(json.RawMessage), nil
}
func (s *Service) queryTasksWireWithin(ctx context.Context, tx pgx.Tx, items []Object, next any) (json.RawMessage, error) {
	wire := []any{}
	for _, item := range items {
		var retained, originalPayload string
		if e := tx.QueryRow(ctx, "SELECT t.snapshot::text,e.payload_text FROM task_requests t JOIN task_events e ON e.id=t.root_event_id WHERE t.id=$1", item["taskId"]).Scan(&retained, &originalPayload); e != nil {
			return nil, e
		}
		snapshot, e := protocol.DecodeOrdered([]byte(retained))
		if e != nil {
			return nil, e
		}
		source := orderedMap(snapshot)
		out := protocol.NewOrderedObject()
		for _, key := range []string{"schemaVersion", "taskId", "caseId", "request", "requesterId", "version", "state", "enrollmentState", "enrollmentOpen", "paused", "governance", "paymentExecuted", "contextAccessGranted", "roomMembershipGranted", "compatibility", "view"} {
			value := item[key]
			switch key {
			case "request":
				value = historyOrder(value, source["request"])
			case "governance":
				g := obj(item, key)
				restrictions := []any{}
				for _, v := range historyArray(g["restrictions"]) {
					r := v.(map[string]any)
					restrictions = append(restrictions, taskOrdered("reportId", r["reportId"], "eventId", r["eventId"], "scopes", r["scopes"], "until", r["until"]))
				}
				value = taskOrdered("scopes", g["scopes"], "restrictions", restrictions, "authority", g["authority"])
			case "compatibility":
				c := obj(item, key)
				value = taskOrdered("writableApiVersion", c["writableApiVersion"], "legacyWrites", c["legacyWrites"])
			}
			out.Set(key, value)
		}
		if textView := obj(item, "textView"); textView != nil {
			fields := obj(textView, "fields")
			orderedFields := protocol.NewOrderedObject()
			for _, key := range []string{"title", "summary", "goal", "currentSituation", "expectedOutcome"} {
				if value, ok := fields[key]; ok {
					orderedFields.Set(key, historyTextField(value.(map[string]any)))
				}
			}
			materials := []any{}
			for _, v := range historyArray(textView["materials"]) {
				m := v.(map[string]any)
				locator := obj(m, "locator")
				entry := taskOrdered("locator", taskOrdered("taskId", locator["taskId"], "materialId", locator["materialId"]), "status", m["status"])
				if m["status"] == "available" {
					entry.Set("text", m["text"])
					entry.Set("availableUntil", m["availableUntil"])
				}
				entry.Set("checkedAt", m["checkedAt"])
				materials = append(materials, entry)
			}
			out.Set("textView", taskOrdered("format", textView["format"], "checkedAt", textView["checkedAt"], "fields", orderedFields, "materials", materials))
			c := obj(item, "rootCommitment")
			out.Set("rootCommitment", taskOrdered("eventId", c["eventId"], "payloadHash", c["payloadHash"], "representation", c["representation"]))
			if _, ok := item["rootRequest"]; ok {
				original, e := protocol.DecodeOrdered([]byte(originalPayload))
				if e != nil {
					return nil, e
				}
				out.Set("rootRequest", historyOrder(item["rootRequest"], original))
			}
		}
		wire = append(wire, out)
	}
	raw, e := protocol.EncodeJS(taskOrdered("items", wire, "nextAfter", next, "coverage", "visible-page-only"))
	return json.RawMessage(raw), e
}
