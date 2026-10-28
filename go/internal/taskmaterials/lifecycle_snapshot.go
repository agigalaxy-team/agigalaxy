package taskmaterials

import "github.com/agigalaxy-team/agigalaxy/go/internal/protocol"

// These transformations remove only the original system-maintained copies of
// selected source events. The approved coordinator owns row selection, locks,
// erasure receipts and persistence; independent authors' text is retained.
func lifecycleClone(snapshot *protocol.OrderedObject) (*protocol.OrderedObject, error) {
	if snapshot == nil {
		return nil, fail("lifecycle_snapshot_invalid", 503)
	}
	raw, e := protocol.EncodeJS(snapshot)
	if e != nil {
		return nil, e
	}
	v, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, e
	}
	return v.(*protocol.OrderedObject), nil
}
func lifecycleObject(v any) *protocol.OrderedObject { o, _ := v.(*protocol.OrderedObject); return o }
func lifecyclePick(v *protocol.OrderedObject, keys ...string) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	if v != nil {
		for _, k := range keys {
			if value, ok := v.Values()[k]; ok {
				o.Set(k, value)
			}
		}
	}
	return o
}
func lifecycleArray(v any) ([]any, error) {
	if v == nil {
		return []any{}, nil
	}
	a, ok := v.([]any)
	if !ok {
		return nil, fail("lifecycle_snapshot_invalid", 503)
	}
	return a, nil
}
func lifecycleRemoved(v *protocol.OrderedObject, key string, removed map[string]bool) bool {
	if v == nil {
		return false
	}
	id, _ := v.Values()[key].(string)
	return removed[id]
}
func lifecycleEvents(v any, removed map[string]bool) ([]any, error) {
	a, e := lifecycleArray(v)
	if e != nil {
		return nil, e
	}
	out := []any{}
	for _, v := range a {
		record := lifecycleObject(v)
		if record == nil {
			return nil, fail("lifecycle_snapshot_invalid", 503)
		}
		event := lifecycleObject(record.Values()["event"])
		if lifecycleRemoved(event, "eventId", removed) {
			copy := lifecyclePick(record, "actorId", "at")
			ev := lifecyclePick(event, "eventId", "kind")
			ev.Set("contentErased", true)
			copy.Set("event", ev)
			out = append(out, copy)
		} else {
			out = append(out, record)
		}
	}
	return out, nil
}
func RedactTaskSnapshot(snapshot *protocol.OrderedObject, removedIDs map[string]bool, subject string) (*protocol.OrderedObject, error) {
	next, e := lifecycleClone(snapshot)
	if e != nil {
		return nil, e
	}
	v := next.Values()
	suggestions := lifecycleObject(v["suggestions"])
	if lifecycleRemoved(suggestions, "eventId", removedIDs) {
		next.Set("suggestions", taskOrdered("state", "content-unavailable", "items", []any{}, "eventId", suggestions.Values()["eventId"]))
	}
	invitations, e := lifecycleArray(v["invitations"])
	if e != nil {
		return nil, e
	}
	for _, value := range invitations {
		invite := lifecycleObject(value)
		if invite == nil {
			return nil, fail("lifecycle_snapshot_invalid", 503)
		}
		if lifecycleRemoved(invite, "invitationId", removedIDs) {
			invite.Set("note", "")
			invite.Set("contentErased", true)
		}
		replies, e := lifecycleArray(invite.Values()["replies"])
		if e != nil {
			return nil, e
		}
		for _, value := range replies {
			reply := lifecycleObject(value)
			if reply == nil {
				return nil, fail("lifecycle_snapshot_invalid", 503)
			}
			if lifecycleRemoved(reply, "eventId", removedIDs) {
				reply.Set("message", "")
				reply.Set("contentErased", true)
			}
		}
		invite.Set("replies", replies)
	}
	next.Set("invitations", invitations)
	applications, e := lifecycleArray(v["applications"])
	if e != nil {
		return nil, e
	}
	for i, value := range applications {
		application := lifecycleObject(value)
		if application == nil {
			return nil, fail("lifecycle_snapshot_invalid", 503)
		}
		if lifecycleRemoved(application, "applicationId", removedIDs) {
			copy := lifecyclePick(application, "applicationId", "subjectId", "state", "at")
			copy.Set("contentErased", true)
			applications[i] = copy
		}
	}
	next.Set("applications", applications)
	events, e := lifecycleEvents(v["events"], removedIDs)
	if e != nil {
		return nil, e
	}
	next.Set("events", events)
	if subject != "" && v["requesterId"] == subject {
		out := taskOrdered("schemaVersion", 2, "contentDeleted", true)
		request := lifecycleObject(v["request"])
		if request != nil {
			if id, ok := request.Values()["taskId"]; ok {
				out.Set("taskId", id)
			}
		}
		out.Set("requesterId", subject)
		if version, ok := v["version"]; ok {
			out.Set("version", version)
		}
		out.Set("state", "source-unavailable")
		ids := []any{}
		for _, value := range events {
			record := lifecycleObject(value)
			if record.Values()["actorId"] != subject {
				event := lifecycleObject(record.Values()["event"])
				var id any
				if event != nil {
					id = event.Values()["eventId"]
				}
				ids = append(ids, id)
			}
		}
		out.Set("independentEventIds", ids)
		return out, nil
	}
	return next, nil
}
func RedactParticipationSnapshot(snapshot *protocol.OrderedObject, removedIDs map[string]bool, subject string) (*protocol.OrderedObject, error) {
	next, e := lifecycleClone(snapshot)
	if e != nil {
		return nil, e
	}
	v := next.Values()
	events, e := lifecycleEvents(v["events"], removedIDs)
	if e != nil {
		return nil, e
	}
	next.Set("events", events)
	if lifecycleRemoved(next, "scopeEventId", removedIDs) {
		next.Set("agreedScope", nil)
		next.Set("scopeAvailable", false)
	}
	if lifecycleRemoved(lifecycleObject(v["pendingScope"]), "eventId", removedIDs) {
		next.Set("pendingScope", nil)
	}
	deliveries, e := lifecycleArray(v["deliveries"])
	if e != nil {
		return nil, e
	}
	for _, value := range deliveries {
		delivery := lifecycleObject(value)
		if delivery == nil {
			return nil, fail("lifecycle_snapshot_invalid", 503)
		}
		if lifecycleRemoved(delivery, "deliveryId", removedIDs) {
			delivery.Set("summary", "")
			delivery.Set("contentErased", true)
		}
		if lifecycleRemoved(lifecycleObject(delivery.Values()["acceptance"]), "eventId", removedIDs) {
			delivery.Set("acceptance", nil)
		}
	}
	next.Set("deliveries", deliveries)
	for _, key := range []string{"dispute", "disputeResolution"} {
		if lifecycleRemoved(lifecycleObject(v[key]), "eventId", removedIDs) {
			next.Set(key, nil)
		}
	}
	if lifecycleObject(v["feedback"]) != nil && (lifecycleRemoved(lifecycleObject(v["feedback"]), "eventId", removedIDs) || subject != "" && v["subjectId"] == subject) {
		next.Set("feedback", nil)
	}
	if subject != "" && v["subjectId"] == subject {
		next.Set("contentDeleted", true)
		next.Set("state", "source-unavailable")
	}
	return next, nil
}
