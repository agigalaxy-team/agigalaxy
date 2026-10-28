package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func (h *NativePersonalSummaries) reconcile(ctx context.Context, l *personalSummaryLease, id, version string) (map[string]any, error) {
	s, e := l.read(ctx)
	if e != nil {
		return nil, e
	}
	var q map[string]any
	for _, v := range uploadRows(s["queue"]) {
		r := psObject(v)
		if r["summaryId"] == id && r["versionId"] == version {
			q = r
			break
		}
	}
	endpoint := q["endpoint"]
	if q == nil {
		endpoint = psObject(psObject(s["summaries"])[id])["endpoint"]
	}
	if l.connection == nil || l.connection.Endpoint != endpoint {
		return nil, connectionFailure("matching_binding_required")
	}
	result, e := l.call(ctx, "receipt", map[string]any{"summaryId": id, "versionId": version})
	if e != nil {
		return nil, e
	}
	if result["operationVersionId"] != version || !isOne(text(result["state"]), "committed", "absent") || result["state"] == "committed" && psObject(result["operation"])["summaryId"] != id {
		return nil, connectionFailure("summary_receipt_mismatch")
	}
	_, e = l.update(ctx, func(t map[string]any) error {
		entry := psQueueFind(t, version)
		r := psObject(psObject(t["summaries"])[id])
		if entry == nil || entry["summaryId"] != id || r == nil {
			return nil
		}
		r["lastReceipt"] = map[string]any{"versionId": version, "state": result["state"]}
		if result["state"] == "absent" {
			if entry["receiptOnly"] == true {
				psFilterQueue(t, func(q map[string]any) bool { return q["versionId"] != version })
			} else {
				entry["state"] = "queued"
				entry["dueAt"] = h.runtime.connection.now().Unix()
			}
			return nil
		}
		remote := psObject(result["summary"])
		op := psObject(result["operation"])
		revision := remote["revision"]
		if revision == nil {
			revision = op["revision"]
		}
		r["cloudRevision"] = revision
		conflicts := remote["conflicts"]
		if conflicts == nil {
			conflicts = []any{}
		}
		r["conflicts"] = psClone(conflicts)
		if op["state"] == "conflict" && entry["receiptOnly"] != true {
			entry["state"] = "conflict"
			r["syncState"] = "conflict"
			r["remoteCurrent"] = psClone(remote["current"])
		} else {
			psFilterQueue(t, func(q map[string]any) bool { return q["versionId"] != version })
			for _, v := range uploadRows(t["queue"]) {
				later := psObject(v)
				if later["summaryId"] == id && later["state"] == "queued" {
					later["baseRevision"] = revision
				}
			}
			switch op["state"] {
			case "deleted":
				r["syncState"] = "cloud-deleted"
			case "expired":
				r["syncState"] = "cloud-expired"
			case "superseded":
				r["syncState"] = "conflict"
				r["remoteCurrent"] = psClone(remote["current"])
			default:
				if r["sourceInvalidated"] != true && psInt(r["localRevision"]) == psInt(entry["localRevision"]) {
					r["syncState"] = "synced"
				}
			}
		}
		return nil
	})
	if e != nil {
		return nil, e
	}
	if e = l.check(ctx, true); e != nil {
		return nil, e
	}
	result["newUploads"] = 0
	return result, nil
}
func (h *NativePersonalSummaries) synchronize(ctx context.Context, l *personalSummaryLease, force bool) (map[string]any, error) {
	s, e := l.read(ctx)
	if e != nil {
		return nil, e
	}
	p := psObject(s["preference"])
	if l.connection == nil || l.connection.Endpoint != p["endpoint"] {
		return map[string]any{"state": "local", "reason": "matching_binding_required"}, nil
	}
	if p["needsPreferenceSync"] == true {
		expected := psClone(p)
		remote, e := l.call(ctx, "preferences/read", map[string]any{})
		if e != nil {
			return nil, e
		}
		live, e := l.read(ctx)
		if e != nil {
			return nil, e
		}
		if !psEqual(live["preference"], expected) {
			return nil, connectionFailure("summary_choice_changed")
		}
		pref, e := l.call(ctx, "preferences/save", map[string]any{"endpoint": l.connection.Endpoint, "expectedRevision": remote["revision"], "enabled": isOne(text(p["state"]), "enabled", "enabled-pending-binding"), "roomIds": p["roomIds"], "includeExisting": p["includeExisting"]})
		if e != nil {
			return nil, e
		}
		s, e = l.update(ctx, func(t map[string]any) error {
			if !psEqual(t["preference"], expected) {
				return connectionFailure("summary_choice_changed")
			}
			tp := psObject(t["preference"])
			tp["cloudRevision"] = pref["revision"]
			tp["needsPreferenceSync"] = false
			if pref["enabled"] == true {
				tp["state"] = "enabled"
			}
			return nil
		})
		if e != nil {
			return nil, e
		}
		p = psObject(s["preference"])
	}
	if p["state"] != "enabled" {
		return map[string]any{"state": p["state"], "newUploads": 0}, nil
	}
	latest, e := l.call(ctx, "preferences/read", map[string]any{})
	if e != nil {
		return nil, e
	}
	if psInt(latest["revision"]) != psInt(p["cloudRevision"]) {
		s, e = l.update(ctx, func(t map[string]any) error {
			tp := psObject(t["preference"])
			if tp["needsPreferenceSync"] == true {
				return nil
			}
			tp["cloudRevision"] = latest["revision"]
			tp["roomIds"] = psClone(latest["roomIds"])
			tp["includeExisting"] = latest["includeExisting"]
			tp["state"] = "disabled"
			if latest["enabled"] == true {
				tp["state"] = "enabled"
			}
			return nil
		})
		if e != nil {
			return nil, e
		}
		p = psObject(s["preference"])
		if p["state"] != "enabled" {
			return map[string]any{"state": "disabled", "newUploads": 0}, nil
		}
	}
	completed := 0
	for _, pending := range uploadRows(s["queue"]) {
		live, e := l.read(ctx)
		if e != nil {
			return nil, e
		}
		preference := psObject(live["preference"])
		if preference["state"] != "enabled" || preference["needsPreferenceSync"] == true {
			break
		}
		q := psQueueFind(live, text(psObject(pending)["versionId"]))
		if q == nil || q["endpoint"] != l.connection.Endpoint || !force && psInt(q["dueAt"]) > h.runtime.connection.now().Unix() {
			continue
		}
		if isOne(text(q["state"]), "sending", "unknown") || q["receiptOnly"] == true {
			receipt, e := h.reconcile(ctx, l, text(q["summaryId"]), text(q["versionId"]))
			if e != nil {
				return nil, e
			}
			if receipt["state"] == "committed" || q["receiptOnly"] == true {
				completed++
				continue
			}
			state, e := l.read(ctx)
			if e != nil {
				return nil, e
			}
			q = psQueueFind(state, text(q["versionId"]))
			if q == nil {
				continue
			}
		}
		if q["state"] == "conflict" {
			continue
		}
		prior := false
		for _, v := range uploadRows(live["queue"]) {
			other := psObject(v)
			if other["summaryId"] == q["summaryId"] && isOne(text(other["state"]), "unknown", "sending", "conflict") && other["versionId"] != q["versionId"] {
				prior = true
				break
			}
		}
		if prior {
			continue
		}
		original := psObject(psObject(live["summaries"])[text(q["summaryId"])])
		if original == nil || !psAllowed(preference, original) {
			continue
		}
		candidate := psObject(psClone(original))
		candidate["content"] = q["content"]
		checked, e := h.sanitise(ctx, l, candidate)
		if e != nil {
			return nil, e
		}
		if checked.unavailable {
			continue
		}
		if checked.changed {
			if _, e = h.get(ctx, l, text(q["summaryId"])); e != nil {
				return nil, e
			}
			continue
		}
		prefRevision := preference["cloudRevision"]
		resolves := q["resolveVersionIds"]
		if resolves == nil {
			resolves = []any{}
		}
		request := map[string]any{"versionId": q["versionId"], "summaryId": q["summaryId"], "roomId": q["roomId"], "baseRevision": q["baseRevision"], "preferenceRevision": prefRevision, "content": q["content"], "resolveVersionIds": resolves}
		ready := false
		_, e = l.update(ctx, func(t map[string]any) error {
			entry := psQueueFind(t, text(q["versionId"]))
			record := psObject(psObject(t["summaries"])[text(q["summaryId"])])
			tp := psObject(t["preference"])
			if entry != nil && record != nil && tp["state"] == "enabled" && tp["needsPreferenceSync"] != true && psInt(tp["cloudRevision"]) == psInt(prefRevision) && psEqual(tp, preference) && psAllowed(tp, record) {
				entry["state"] = "sending"
				ready = true
			}
			return nil
		})
		if e != nil {
			return nil, e
		}
		if !ready {
			continue
		}
		sendErr := func() error {
			authorized, e := l.read(ctx)
			if e != nil {
				return e
			}
			ap := psObject(authorized["preference"])
			if ap["state"] != "enabled" || ap["needsPreferenceSync"] == true || !psEqual(ap, preference) {
				return connectionFailure("summary_choice_changed")
			}
			dispatch := psQueueFind(authorized, text(q["versionId"]))
			if dispatch == nil || dispatch["receiptOnly"] == true || dispatch["content"] == nil {
				return connectionFailure("summary_sources_changed")
			}
			result, e := l.call(ctx, "put", request)
			if e != nil {
				return e
			}
			_, e = l.update(ctx, func(t map[string]any) error {
				entry := psQueueFind(t, text(q["versionId"]))
				r := psObject(psObject(t["summaries"])[text(q["summaryId"])])
				if entry == nil || r == nil {
					return nil
				}
				conflict := false
				for _, v := range uploadRows(result["conflicts"]) {
					conflict = conflict || psObject(v)["versionId"] == q["versionId"]
				}
				r["cloudRevision"] = result["revision"]
				conflicts := result["conflicts"]
				if conflicts == nil {
					conflicts = []any{}
				}
				r["conflicts"] = psClone(conflicts)
				if conflict {
					entry["state"] = "conflict"
					r["syncState"] = "conflict"
					r["remoteCurrent"] = psClone(result["current"])
				} else {
					psFilterQueue(t, func(v map[string]any) bool { return v["versionId"] != q["versionId"] })
					for _, v := range uploadRows(t["queue"]) {
						later := psObject(v)
						if later["summaryId"] == q["summaryId"] && later["state"] == "queued" {
							later["baseRevision"] = result["revision"]
						}
					}
					if r["sourceInvalidated"] != true && psInt(r["localRevision"]) == psInt(q["localRevision"]) {
						r["syncState"] = "synced"
					}
				}
				return nil
			})
			return e
		}()
		if sendErr != nil {
			_, e = l.update(ctx, func(t map[string]any) error {
				entry := psQueueFind(t, text(q["versionId"]))
				if entry != nil {
					attempt := psInt(entry["attempts"]) + 1
					entry["state"] = "unknown"
					entry["attempts"] = attempt
					delays := []int64{5, 30, 120, 900}
					entry["dueAt"] = h.runtime.connection.now().Unix() + delays[min(max(attempt-1, 0), 3)]
					code := fault.Code(sendErr)
					if !personalSummaryErrorCode.MatchString(code) || code == "internal_error" {
						code = "sync_unavailable"
					}
					entry["error"] = code
				}
				return nil
			})
			if e != nil {
				return nil, e
			}
			return map[string]any{"state": "error", "completed": completed, "retryScheduled": true}, nil
		}
		completed++
	}
	return map[string]any{"state": "checked", "completed": completed}, nil
}
