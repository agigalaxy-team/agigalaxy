package native

import "context"

// Flush continues only the existing saved work choice. No scheduler is started,
// and an unresolved original operation stops that source rather than resending.
func (u *WorkUpload) Flush(ctx context.Context, workID string) (any, error) {
	if !optionalID(workID) {
		return nil, connectionFailure("work_sync_input_invalid")
	}
	expected, e := uploadChoiceScope(ctx, u.runtime.store)
	if e != nil {
		return nil, e
	}
	ctx = uploadScopeContext(ctx, expected)
	settings, e := u.Settings(ctx)
	if e != nil {
		return nil, e
	}
	state := settings.(map[string]any)
	if state["galaxyId"] != expected.Owner && !(state["galaxyId"] == nil && expected.Owner == "") {
		return nil, connectionFailure("work_sync_identity_changed")
	}
	choice := state["choice"].(map[string]any)
	if choice["enabled"] != true {
		return map[string]any{"state": "not-selected", "items": []any{}, "networkStarted": false}, nil
	}
	ids, _ := connectionStrings(choice["workIds"])
	if workID != "" {
		ids = []string{workID}
	} else if choice["includeFutureWork"] == true {
		after := ""
		for {
			page, e := u.runtime.store.WorkList(ctx, WorkQuery{GalaxyID: expected.Owner, Limit: 100, After: after})
			if e != nil {
				return nil, e
			}
			listed := page.(map[string]any)
			for _, value := range uploadRows(listed["items"]) {
				work := uploadObject(value)
				if uploadAfter(work["startedAt"], choice["selectedAt"]) {
					ids = append(ids, text(work["workId"]))
				}
			}
			next := text(listed["nextAfter"])
			if next == "" {
				break
			}
			after = next
		}
	}
	items := []any{}
	seenSources := map[string]bool{}
	for _, id := range ids {
		if seenSources[id] {
			continue
		}
		seenSources[id] = true
		deletion := UploadCloudQuery{TargetAccountID: text(choice["targetAccountId"]), WorkID: id}
		pending, e := u.runtime.uploadPendingDelete(ctx, deletion, "work", &expected)
		if e != nil {
			return nil, e
		}
		if pending {
			result, e := u.deleteCloud(ctx, deletion, &expected, true)
			if e != nil {
				return nil, e
			}
			if uploadObject(result)["state"] == "unknown" {
				items = append(items, result)
				continue
			}
		}
		seenOperations := map[string]bool{}
		for {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			prepared, e := u.Prepare(ctx, id)
			if e != nil {
				items = append(items, map[string]any{"workId": id, "state": "not-synced", "error": runtimeErrorCode(e)})
				break
			}
			view := prepared.(map[string]any)
			operationID := text(view["operationId"])
			if operationID == "" || seenOperations[operationID] {
				break
			}
			seenOperations[operationID] = true
			result, e := u.Resume(ctx, operationID)
			if e != nil {
				items = append(items, map[string]any{"workId": id, "state": "not-synced", "error": runtimeErrorCode(e)})
				break
			}
			items = append(items, result)
			if !isOne(text(uploadObject(result)["state"]), "stored", "superseded") {
				break
			}
		}
	}
	return map[string]any{"state": "processed", "items": items}, nil
}
