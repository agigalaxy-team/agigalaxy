package native

import (
	"context"
	"fmt"
	"github.com/google/uuid"
	"regexp"
	"sort"
)

func (h *NativePersonalSummaries) queueRecord(r map[string]any) map[string]any {
	base := r["cloudRevision"]
	if base == nil {
		base = 0
	}
	return map[string]any{"summaryId": r["summaryId"], "endpoint": r["endpoint"], "versionId": uuid.NewString(), "localRevision": r["localRevision"], "baseRevision": base, "roomId": r["roomId"], "content": psClone(r["content"]), "state": "queued", "dueAt": h.runtime.connection.now().Unix() + 10, "attempts": 0}
}
func (h *NativePersonalSummaries) save(ctx context.Context, l *personalSummaryLease, x map[string]any) (any, error) {
	content, e := psContent(x["content"])
	if e != nil {
		return nil, e
	}
	id := text(x["summaryId"])
	if id == "" {
		id = uuid.NewString()
	}
	room := text(x["roomId"])
	if !controlUUID(id) || !controlUUID(room) || !personalSummaryLocalUUID.MatchString(id) || !personalSummaryLocalUUID.MatchString(room) {
		return nil, connectionFailure("invalid_summary_id")
	}
	expected := psInt(x["expectedLocalRevision"])
	now := h.runtime.connection.now().Unix()
	s, e := l.update(ctx, func(s map[string]any) error {
		records := psObject(s["summaries"])
		prev := psObject(records[id])
		if psInt(prev["localRevision"]) != expected {
			return connectionFailure("local_summary_conflict")
		}
		if prev != nil && (prev["roomId"] != room || prev["endpoint"] != l.scope.Endpoint) {
			return connectionFailure("summary_room_conflict")
		}
		created := any(now)
		cloud := any(0)
		conflicts := any([]any{})
		if prev != nil {
			created = prev["createdAt"]
			cloud = prev["cloudRevision"]
			conflicts = prev["conflicts"]
		}
		r := map[string]any{"summaryId": id, "roomId": room, "endpoint": l.scope.Endpoint, "content": psClone(content), "createdAt": created, "updatedAt": now, "localRevision": expected + 1, "cloudRevision": cloud, "syncState": "local", "conflicts": conflicts}
		if prev["remoteCurrent"] != nil {
			r["remoteCurrent"] = psClone(prev["remoteCurrent"])
		}
		records[id] = r
		psFilterQueue(s, func(q map[string]any) bool {
			return q["summaryId"] != id || isOne(text(q["state"]), "unknown", "sending")
		})
		if psAllowed(psObject(s["preference"]), r) {
			s["queue"] = append(uploadRows(s["queue"]), h.queueRecord(r))
			r["syncState"] = "queued"
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	return psClone(psObject(s["summaries"])[id]), nil
}
func (h *NativePersonalSummaries) choose(ctx context.Context, l *personalSummaryLease, x map[string]any, scope *ChoiceScope) (any, error) {
	if scope == nil || *scope != l.scope {
		return nil, connectionFailure("summary_choice_required")
	}
	enabled, _ := x["enabled"].(bool)
	return l.update(ctx, func(s map[string]any) error {
		prior := psObject(s["preference"])
		state := "enabled-pending-binding"
		if !enabled {
			state = "disabled"
			if prior["state"] == "unset" {
				state = "declined"
			}
		}
		var cloud any
		if prior["endpoint"] == l.scope.Endpoint {
			cloud = prior["cloudRevision"]
		}
		rooms := x["roomIds"]
		include := x["includeExisting"]
		if include == nil {
			include = true
		}
		p := map[string]any{"state": state, "endpoint": l.scope.Endpoint, "roomIds": psClone(rooms), "includeExisting": include, "selectedAt": h.runtime.connection.now().Unix(), "cloudRevision": cloud, "needsPreferenceSync": true}
		s["preference"] = p
		psFilterQueue(s, func(q map[string]any) bool { return isOne(text(q["state"]), "unknown", "sending", "conflict") })
		if enabled {
			for _, r := range psSummaryRecords(s, l.order) {
				if !psAllowed(p, r) {
					continue
				}
				has := false
				for _, v := range uploadRows(s["queue"]) {
					has = has || psObject(v)["summaryId"] == r["summaryId"]
				}
				if !has {
					s["queue"] = append(uploadRows(s["queue"]), h.queueRecord(r))
				}
			}
		}
		return nil
	})
}

type personalSummarySanitised struct {
	record               map[string]any
	changed, unavailable bool
}

func (h *NativePersonalSummaries) sanitise(ctx context.Context, l *personalSummaryLease, record map[string]any) (personalSummarySanitised, error) {
	out := personalSummarySanitised{record: psObject(psClone(record))}
	cache := map[string]map[string]any{}
	check := func(ref map[string]any) map[string]any {
		id := fmt.Sprintf("%s:%d", text(ref["messageId"]), psInt(ref["revision"]))
		if found, ok := cache[id]; ok {
			return found
		}
		status := map[string]any{"available": false, "unchecked": true}
		if l.connection == nil || record["endpoint"] == nil || record["endpoint"] != l.connection.Endpoint {
			out.unavailable = true
		} else {
			result, e := l.call(ctx, "sources", map[string]any{"roomId": record["roomId"], "refs": []any{ref}})
			if e != nil {
				out.unavailable = true
			} else {
				items := uploadRows(result["items"])
				if len(items) > 0 && psObject(items[0]) != nil {
					status = psObject(items[0])
				} else {
					out.unavailable = true
				}
				if status["temporarilyUnavailable"] == true {
					out.unavailable = true
				}
			}
		}
		cache[id] = status
		return status
	}
	contents := []map[string]any{psObject(out.record["content"]), psObject(psObject(out.record["remoteCurrent"])["content"])}
	for _, v := range uploadRows(out.record["conflicts"]) {
		contents = append(contents, psObject(psObject(v)["content"]))
	}
	for _, content := range contents {
		if content == nil || content["fragments"] == nil {
			continue
		}
		changed := false
		fragments := []any{}
		for _, v := range uploadRows(content["fragments"]) {
			f := psObject(v)
			allowed := true
			for _, ref := range uploadRows(f["sourceRefs"]) {
				if check(psObject(ref))["available"] != true {
					allowed = false
				}
			}
			if allowed {
				fragments = append(fragments, f)
			} else {
				changed = true
			}
		}
		refs := []any{}
		for _, v := range uploadRows(content["keyMessageRefs"]) {
			if check(psObject(v))["available"] == true {
				refs = append(refs, v)
			} else {
				changed = true
			}
		}
		content["fragments"] = fragments
		content["keyMessageRefs"] = refs
		if changed {
			psObject(content["coverage"])["complete"] = false
			out.changed = true
		}
	}
	if len(cache) > 0 && l.connection != nil {
		if e := l.check(ctx, true); e != nil {
			out.changed = true
			out.unavailable = true
			for _, content := range contents {
				if content == nil {
					continue
				}
				notes := []any{}
				for _, v := range uploadRows(content["fragments"]) {
					if len(uploadRows(psObject(v)["sourceRefs"])) == 0 {
						notes = append(notes, v)
					}
				}
				content["fragments"] = notes
				content["keyMessageRefs"] = []any{}
				psObject(content["coverage"])["complete"] = false
			}
		}
	}
	return out, nil
}
func (h *NativePersonalSummaries) get(ctx context.Context, l *personalSummaryLease, id string) (any, error) {
	s, e := l.read(ctx)
	if e != nil {
		return nil, e
	}
	r := psObject(psObject(s["summaries"])[id])
	if r == nil {
		return nil, nil
	}
	safe, e := h.sanitise(ctx, l, r)
	if e != nil {
		return nil, e
	}
	if safe.changed && !safe.unavailable {
		_, e = l.update(ctx, func(t map[string]any) error {
			v := psObject(psObject(t["summaries"])[id])
			if psEqual(v, r) {
				v["content"] = psClone(safe.record["content"])
				v["conflicts"] = psClone(safe.record["conflicts"])
				if safe.record["remoteCurrent"] != nil {
					v["remoteCurrent"] = psClone(safe.record["remoteCurrent"])
				}
				v["sourceInvalidated"] = true
				v["syncState"] = "sources-changed"
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
			}
			return nil
		})
		if e != nil {
			return nil, e
		}
	}
	state := "current"
	if safe.unavailable {
		state = "unverified-offline"
	} else if safe.changed {
		state = "changed"
	}
	safe.record["sourceState"] = state
	safe.record["sharedToRoom"] = false
	return safe.record, l.check(ctx, false)
}
func (h *NativePersonalSummaries) status(ctx context.Context, l *personalSummaryLease) (map[string]any, error) {
	s, e := l.read(ctx)
	if e != nil {
		return nil, e
	}
	p := psObject(s["preference"])
	pending := []any{}
	for _, v := range uploadRows(s["queue"]) {
		q := psObject(v)
		if l.connection != nil && q["endpoint"] == l.connection.Endpoint && isOne(text(q["state"]), "sending", "unknown") {
			pending = append(pending, map[string]any{"summaryId": q["summaryId"], "versionId": q["versionId"], "endpoint": q["endpoint"], "state": q["state"], "receiptOnly": q["receiptOnly"] == true})
		}
	}
	return map[string]any{"subjectId": l.scope.Owner, "preference": psClone(p), "promptNeeded": p["state"] == "unset", "connected": l.connection != nil, "syncTargetMatches": l.connection != nil && l.connection.Endpoint == p["endpoint"], "queued": len(uploadRows(s["queue"])), "pendingOperations": pending, "summaryCount": len(psObject(s["summaries"])), "modelRunning": false}, nil
}
func (h *NativePersonalSummaries) list(ctx context.Context, l *personalSummaryLease) (any, error) {
	s, e := l.read(ctx)
	if e != nil {
		return nil, e
	}
	records := psSummaryRecords(s, l.order)
	sort.SliceStable(records, func(i, j int) bool { return psInt(records[i]["updatedAt"]) > psInt(records[j]["updatedAt"]) })
	out := []any{}
	for _, r := range records {
		m := map[string]any{}
		for _, k := range []string{"summaryId", "roomId", "endpoint", "updatedAt", "localRevision", "syncState"} {
			m[k] = r[k]
		}
		out = append(out, m)
	}
	return out, nil
}

var personalSummaryLocalUUID = regexp.MustCompile(`^[0-9a-f-]{36}$`)
