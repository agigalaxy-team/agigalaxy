package native

import "context"

// Candidate declarations are readable sources, not a promise to accept work
// or a configured endpoint. Keep the service's distinct status fields intact.
func (l *helpLease) participantSource(ctx context.Context, request map[string]any) (map[string]any, []any, error) {
	input := psObject(request["input"])
	path := "/v2/discovery/participants/query"
	if request["kind"] == "participant-v2" {
		path = "/v2/discovery/participants/detail"
	}
	page, _, e := l.call(ctx, path, input)
	if e != nil {
		return nil, nil, e
	}
	if psInt(page["schemaVersion"]) != 2 || page["capabilityVerified"] != false {
		return nil, nil, helpError("help_source_invalid")
	}
	if request["kind"] == "participant-v2" {
		candidate := psObject(page["participant"])
		if candidate == nil || candidate["sourceKind"] != input["sourceKind"] || candidate["id"] != input["id"] {
			return nil, nil, helpError("help_source_invalid")
		}
		page["items"] = []any{candidate}
	}
	rows, ok := page["items"].([]any)
	if !ok || len(rows) > 20 {
		return nil, nil, helpError("help_source_invalid")
	}
	refs := []any{}
	for _, raw := range rows {
		item := psObject(raw)
		sourceKind, id := text(item["sourceKind"]), text(item["id"])
		if !isOne(sourceKind, "profile", "project", "builder", "recruitment") || id == "" || item["capabilityVerified"] != false || !helpSubject.MatchString(text(item["subjectId"])) {
			return nil, nil, helpError("help_source_invalid")
		}
		revision := helpHash(item["sources"])
		locator := map[string]any{"sourceKind": sourceKind, "id": id, "apiVersion": 2, "contentVersion": revision}
		ref := map[string]any{"key": helpHash([]any{l.scope.Endpoint, "participant", sourceKind, id, revision}), "kind": "participant", "id": sourceKind + ":" + id, "sourceRevision": revision, "locator": locator, "checkedAt": l.host.now(), "classification": "self-declared", "participantIds": []any{item["subjectId"]}, "capabilityVerified": false, "availability": "unknown"}
		if e = helpValidate("basis", ref); e != nil {
			return nil, nil, e
		}
		refs = append(refs, ref)
	}
	return page, refs, l.check(ctx)
}
