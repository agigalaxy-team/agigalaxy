package native

import (
	"context"
	"math"
	"time"
)

func psSafeInteger(v any) bool {
	switch n := v.(type) {
	case float64:
		return n >= 0 && n <= 9007199254740991 && !math.IsInf(n, 0) && !math.IsNaN(n) && math.Trunc(n) == n
	case int:
		return n >= 0
	case int64:
		return n >= 0 && n <= 9007199254740991
	}
	return false
}
func psCloudView(value map[string]any, id, room string) error {
	bad := func() error { return connectionFailure("summary_cloud_response_mismatch") }
	if value == nil || !controlUUID(value["summaryId"]) || id != "" && value["summaryId"] != id || !psSafeInteger(value["revision"]) || value["audience"] != "owner-only" || value["sharedToRoom"] != false {
		return bad()
	}
	conflicts, ok := value["conflicts"].([]any)
	if !ok {
		return bad()
	}
	current, present := value["current"]
	if !present || current != nil && psObject(current) == nil {
		return bad()
	}
	if (current != nil || len(conflicts) > 0) && !controlUUID(value["roomId"]) || value["roomId"] != nil && !controlUUID(value["roomId"]) || room != "" && value["roomId"] != room {
		return bad()
	}
	versions := append([]any{}, conflicts...)
	if current != nil {
		versions = append(versions, current)
	}
	for _, raw := range versions {
		v := psObject(raw)
		if v == nil || v["summaryId"] != value["summaryId"] || v["roomId"] != nil && v["roomId"] != value["roomId"] || !controlUUID(v["versionId"]) || !psSafeInteger(v["revision"]) || !isOne(text(v["state"]), "current", "conflict", "expired", "deleted", "superseded") {
			return bad()
		}
		if isOne(text(v["state"]), "current", "conflict") {
			if _, e := psContent(v["content"]); e != nil {
				return bad()
			}
		} else if c := psObject(v["content"]); c == nil || len(c) != 0 {
			return bad()
		}
	}
	for _, v := range conflicts {
		if psObject(v)["state"] != "conflict" {
			return bad()
		}
	}
	if psObject(current)["state"] == "conflict" {
		return bad()
	}
	return nil
}
func (h *NativePersonalSummaries) pull(ctx context.Context, l *personalSummaryLease, id string) (any, error) {
	s, e := l.read(ctx)
	if e != nil {
		return nil, e
	}
	if l.connection == nil {
		return nil, connectionFailure("matching_binding_required")
	}
	before := psObject(psObject(s["summaries"])[id])
	expected := psInt(before["localRevision"])
	if before != nil && before["endpoint"] != l.connection.Endpoint {
		return nil, connectionFailure("summary_target_mismatch")
	}
	remote, e := l.call(ctx, "get", map[string]any{"summaryId": id})
	if e != nil {
		return nil, e
	}
	if e = psCloudView(remote, id, ""); e != nil {
		return nil, e
	}
	current := psObject(remote["current"])
	content := psObject(current["content"])
	unavailable := current["sourcesTemporarilyUnavailable"] == true
	for _, v := range uploadRows(remote["conflicts"]) {
		unavailable = unavailable || psObject(v)["sourcesTemporarilyUnavailable"] == true
	}
	if content["fragments"] == nil || unavailable {
		return remote, nil
	}
	parsed, e := psContent(content)
	if e != nil {
		return nil, e
	}
	_, e = l.update(ctx, func(t map[string]any) error {
		records := psObject(t["summaries"])
		local := psObject(records[id])
		if psInt(local["localRevision"]) != expected {
			return connectionFailure("local_summary_conflict")
		}
		if local != nil && (local["roomId"] != remote["roomId"] || local["endpoint"] != l.connection.Endpoint) {
			return connectionFailure("summary_room_conflict")
		}
		queued := false
		for _, v := range uploadRows(t["queue"]) {
			queued = queued || psObject(v)["summaryId"] == id
		}
		if local != nil && (queued || !psEqual(local["content"], parsed) || isOne(text(local["syncState"]), "local", "conflict")) {
			local["remoteCurrent"] = psClone(remote["current"])
			local["conflicts"] = psClone(remote["conflicts"])
			local["cloudRevision"] = remote["revision"]
			local["syncState"] = "conflict"
			return nil
		}
		var created any
		if local != nil {
			created = local["createdAt"]
		} else if at, e := time.Parse(time.RFC3339Nano, text(current["updatedAt"])); e == nil {
			created = float64(at.UnixMilli()) / 1000
		}
		records[id] = map[string]any{"summaryId": id, "roomId": remote["roomId"], "endpoint": l.connection.Endpoint, "content": psClone(parsed), "createdAt": created, "updatedAt": h.runtime.connection.now().Unix(), "localRevision": expected + 1, "cloudRevision": remote["revision"], "syncState": "synced", "conflicts": psClone(remote["conflicts"])}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return remote, l.check(ctx, true)
}
func (h *NativePersonalSummaries) resolve(ctx context.Context, l *personalSummaryLease, x map[string]any, scope *ChoiceScope) (any, error) {
	if scope == nil || *scope != l.scope {
		return nil, connectionFailure("summary_resolution_choice_required")
	}
	content, e := psContent(x["content"])
	if e != nil {
		return nil, e
	}
	id := text(x["summaryId"])
	s, e := l.update(ctx, func(t map[string]any) error {
		records := psObject(t["summaries"])
		r := psObject(records[id])
		if r == nil {
			return connectionFailure("summary_missing")
		}
		if psInt(r["localRevision"]) != psInt(x["expectedLocalRevision"]) {
			return connectionFailure("local_summary_conflict")
		}
		for _, v := range uploadRows(t["queue"]) {
			q := psObject(v)
			if q["summaryId"] == id && isOne(text(q["state"]), "unknown", "sending") {
				return connectionFailure("summary_original_receipt_required")
			}
		}
		next := psObject(psClone(r))
		next["content"] = psClone(content)
		next["localRevision"] = psInt(r["localRevision"]) + 1
		next["updatedAt"] = h.runtime.connection.now().Unix()
		next["syncState"] = "local"
		next["conflicts"] = []any{}
		delete(next, "remoteCurrent")
		delete(next, "sourceInvalidated")
		records[id] = next
		psFilterQueue(t, func(q map[string]any) bool { return q["summaryId"] != id })
		if psAllowed(psObject(t["preference"]), next) {
			q := h.queueRecord(next)
			ids := []any{}
			for _, v := range uploadRows(r["conflicts"]) {
				ids = append(ids, psObject(v)["versionId"])
			}
			q["resolveVersionIds"] = ids
			t["queue"] = append(uploadRows(t["queue"]), q)
			next["syncState"] = "queued"
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return psClone(psObject(s["summaries"])[id]), nil
}
func (h *NativePersonalSummaries) deleteCloud(ctx context.Context, l *personalSummaryLease, id string, scope *ChoiceScope) (any, error) {
	if scope == nil || *scope != l.scope {
		return nil, connectionFailure("summary_delete_choice_required")
	}
	s, e := l.read(ctx)
	if e != nil {
		return nil, e
	}
	if l.connection == nil || l.connection.Endpoint != psObject(s["preference"])["endpoint"] {
		return nil, connectionFailure("matching_binding_required")
	}
	remote, e := l.call(ctx, "get", map[string]any{"summaryId": id})
	if e != nil {
		return nil, e
	}
	receipt, e := l.call(ctx, "delete", map[string]any{"summaryId": id, "expectedRevision": remote["revision"]})
	if e != nil {
		return nil, e
	}
	_, e = l.update(ctx, func(t map[string]any) error {
		psFilterQueue(t, func(q map[string]any) bool {
			if q["summaryId"] != id {
				return true
			}
			if !isOne(text(q["state"]), "sending", "unknown") {
				return false
			}
			q["receiptOnly"] = true
			delete(q, "content")
			delete(q, "resolveVersionIds")
			return true
		})
		if r := psObject(psObject(t["summaries"])[id]); r != nil {
			r["syncState"] = "cloud-deleted"
			r["cloudRevision"] = psInt(remote["revision"]) + 1
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return receipt, l.check(ctx, true)
}
func (h *NativePersonalSummaries) onBinding(ctx context.Context, l *personalSummaryLease) (map[string]any, error) {
	before, e := l.read(ctx)
	if e != nil {
		return nil, e
	}
	if l.connection == nil {
		return map[string]any{"state": "local"}, nil
	}
	p := psObject(before["preference"])
	if p["state"] == "declined" && p["endpoint"] == nil {
		if _, e = l.update(ctx, func(t map[string]any) error {
			pref := psObject(t["preference"])
			pref["endpoint"] = l.connection.Endpoint
			pref["needsPreferenceSync"] = true
			return nil
		}); e != nil {
			return nil, e
		}
	}
	if p["state"] != "unset" {
		return h.synchronize(ctx, l, false)
	}
	remote, e := l.call(ctx, "preferences/read", map[string]any{})
	if e != nil {
		return nil, e
	}
	if psInt(remote["revision"]) == 0 {
		return map[string]any{"state": "unset", "promptNeeded": true}, nil
	}
	_, e = l.update(ctx, func(t map[string]any) error {
		if psObject(t["preference"])["state"] != "unset" {
			return nil
		}
		state := "declined"
		if remote["enabled"] == true {
			state = "enabled"
		}
		var selected any
		if at, e := time.Parse(time.RFC3339Nano, text(remote["enabledSince"])); e == nil {
			selected = float64(at.UnixMilli()) / 1000
		}
		pref := map[string]any{"state": state, "endpoint": l.connection.Endpoint, "roomIds": psClone(remote["roomIds"]), "includeExisting": remote["includeExisting"], "selectedAt": selected, "cloudRevision": remote["revision"], "needsPreferenceSync": false}
		t["preference"] = pref
		if remote["enabled"] == true {
			for _, r := range psSummaryRecords(t, l.order) {
				if r["syncState"] != "local" || !psAllowed(pref, r) {
					continue
				}
				found := false
				for _, v := range uploadRows(t["queue"]) {
					found = found || psObject(v)["summaryId"] == r["summaryId"]
				}
				if !found {
					t["queue"] = append(uploadRows(t["queue"]), h.queueRecord(r))
				}
			}
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return h.status(ctx, l)
}
func (h *NativePersonalSummaries) OnBinding(ctx context.Context) (map[string]any, error) {
	ctx, cancel, l, e := h.begin(ctx)
	if e != nil {
		return nil, e
	}
	defer cancel()
	h.syncMu.Lock()
	defer h.syncMu.Unlock()
	return h.onBinding(ctx, l)
}
