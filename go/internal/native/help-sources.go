package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"regexp"
)

var helpSubject = regexp.MustCompile(`^GUID[0-9A-Z]{28}$`)
var helpDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)

func helpOrdered(values map[string]any, keys ...string) *protocol.OrderedObject {
	o := protocol.NewOrderedObject()
	for _, k := range keys {
		if v, ok := values[k]; ok {
			o.Set(k, v)
		}
	}
	return o
}
func helpHash(v any) string { raw, _ := protocol.EncodeJS(v); return identity.Digest(raw) }
func helpUnique(values []any) []any {
	out := []any{}
	seen := map[string]bool{}
	for _, v := range values {
		s := text(v)
		if !seen[s] {
			seen[s] = true
			out = append(out, v)
		}
	}
	return out
}
func helpKnown(row map[string]any) map[string]bool {
	out := map[string]bool{}
	for _, v := range trustArray(row["queries"]) {
		q := psObject(v)
		if isOne(text(q["state"]), "ready", "empty") {
			for _, k := range helpStrings(q["basisKeys"]) {
				out[k] = true
			}
		}
	}
	return out
}
func helpSourceError(e error) string {
	code := runtimeErrorCode(e)
	if isOne(code, "not_found", "binding_revoked", "insufficient_scope", "consent_revoked") {
		return code
	}
	return "source_failed"
}
func (l *helpLease) source(ctx context.Context, request map[string]any) (map[string]any, []any, error) {
	at := l.host.now()
	kind := text(request["kind"])
	input := psObject(request["input"])
	path := ""
	switch kind {
	case "search-v2":
		raw, _ := protocol.Encode(input)
		parsed, e := searchv2.ParseQuery(raw)
		if e != nil {
			return nil, nil, e
		}
		input = parsed
		path = "/v2/search/query"
	case "discovery-v2":
		parsed, e := opportunities.ParseQuery(input)
		if e != nil {
			return nil, nil, e
		}
		input = parsed
		path = "/v2/discovery/query"
	case "search":
		path = "/v1/search/query"
	case "discovery":
		path = "/v1/discovery/query"
	default:
		return nil, nil, helpError("help_source_invalid")
	}
	page, ordered, e := l.call(ctx, path, input)
	if e != nil {
		return nil, nil, e
	}
	rows, ok := page["items"].([]any)
	if !ok || len(rows) > 40 || page["endpoint"] != nil && page["endpoint"] != l.scope.Endpoint {
		return nil, nil, helpError("help_source_invalid")
	}
	if kind == "search-v2" || kind == "discovery-v2" {
		limit := psInt(input["limit"])
		if kind == "search-v2" {
			limit = psInt(psObject(input["query"])["limit"])
		}
		if psInt(page["schemaVersion"]) != 2 || page["capabilityVerified"] != false || int64(len(rows)) > limit {
			return nil, nil, helpError("help_source_invalid")
		}
		if kind == "search-v2" {
			if page["type"] != input["type"] || !psSafeInteger(page["checkedAt"]) {
				return nil, nil, helpError("help_source_invalid")
			}
		} else if !psSafeInteger(page["computedAt"]) {
			return nil, nil, helpError("help_source_invalid")
		}
		cursor := page["nextAfter"]
		if kind == "search-v2" {
			cursor = page["nextCursor"]
		}
		if cursor != nil {
			value, ok := cursor.(string)
			if !ok || len(jstext.From(value)) > 4096 {
				return nil, nil, helpError("help_source_invalid")
			}
		}
	} else if kind == "search" {
		if psInt(page["version"]) != 1 || page["type"] != input["type"] || page["endpoint"] != l.scope.Endpoint || page["capabilityVerified"] != false || int64(len(rows)) > psInt(psObject(input["query"])["limit"]) {
			return nil, nil, helpError("help_source_invalid")
		}
		if page["nextCursor"] != nil && !controlUUID(page["nextCursor"]) {
			return nil, nil, helpError("help_source_invalid")
		}
		for _, v := range rows {
			r := psObject(v)
			if r["type"] != input["type"] || !controlUUID(r["id"]) {
				return nil, nil, helpError("help_source_invalid")
			}
			if _, ok := r["matchReasons"].([]any); !ok {
				return nil, nil, helpError("help_source_invalid")
			}
		}
	} else {
		if e = helpValidate("legacyDiscoveryPage", page); e != nil {
			return nil, nil, e
		}
		if int64(len(rows)) > psInt(input["limit"]) {
			return nil, nil, helpError("help_source_invalid")
		}
		for _, v := range rows {
			r := psObject(v)
			sources := trustArray(r["sources"])
			if len(sources) < 2 || psObject(sources[0])["projectId"] != input["projectId"] || psObject(sources[1])["subjectId"] != r["subjectId"] || psObject(sources[1])["projectId"] != psObject(r["project"])["id"] {
				return nil, nil, helpError("help_source_invalid")
			}
		}
	}
	orderedRows := trustArray(watchObject(ordered)["items"])
	refs := []any{}
	for i, v := range rows {
		item := psObject(v)
		wire := map[string]any{}
		if i < len(orderedRows) {
			wire = watchObject(orderedRows[i])
		}
		record := psObject(item["record"])
		source := psObject(item["source"])
		locator := protocol.NewOrderedObject()
		sourceRevision := ""
		participants := []any{}
		discovery := kind == "discovery-v2" || kind == "discovery"
		basisKind := text(item["type"])
		if discovery {
			record = item
			basisKind = "project-match"
		}
		if kind == "search-v2" || kind == "discovery-v2" {
			if discovery {
				source = psObject(item["opportunityRef"])
				if !helpDigest.MatchString(text(item["id"])) || item["capabilityVerified"] != false || source["subjectId"] != item["subjectId"] {
					return nil, nil, helpError("help_source_invalid")
				}
			}
			if source == nil {
				return nil, nil, helpError("help_source_invalid")
			}
			locator = helpOrdered(source, "sourceKind", "id", "versionId", "version", "schemaVersion", "key", "projectionRule", "subjectId", "projectId", "statementId", "documentEventId", "policyEventId", "recruitmentId", "eventId", "taskId", "operationId", "declarationId", "declarationHash", "revision")
			locator.Set("apiVersion", 2)
			if discovery {
				digest := protocol.NewOrderedObject()
				digest.Set("source", wire["opportunityRef"])
				for _, k := range []string{"help", "willingness", "match"} {
					if x, ok := wire[k]; ok {
						digest.Set(k, x)
					}
				}
				sourceRevision = helpHash(digest)
			} else {
				ref := psObject(item["ref"])
				sourceRevision = text(ref["version"])
				if item["type"] != input["type"] || ref["id"] != item["id"] || !helpDigest.MatchString(sourceRevision) || item["sourceVersion"] != sourceRevision || item["capabilityVerified"] != false || record == nil {
					return nil, nil, helpError("help_source_invalid")
				}
			}
			locator.Set("contentVersion", sourceRevision)
			for _, k := range []string{"subjectId", "requesterId", "authorId", "ownerId"} {
				participants = append(participants, record[k])
			}
			participants = append(participants, psObject(record["participant"])["subjectId"], record["reportedBy"])
			for _, k := range []string{"attempts", "interventions", "results", "verificationRecords", "participation", "participations"} {
				for _, v := range trustArray(record[k]) {
					p := psObject(v)
					for _, f := range []string{"actorId", "subjectId", "reportedBy"} {
						participants = append(participants, p[f])
					}
				}
			}
			participants = append(participants, trustArray(record["contributors"])...)
		} else {
			if kind == "search" {
				if source == nil {
					return nil, nil, helpError("help_source_invalid")
				}
				locator = helpOrdered(source, "kind", "id", "versionId", "version", "sourceVersion", "projectionRule", "declarationId", "declarationHash", "revision", "evidenceId", "observationId")
				participants = []any{source["ownerId"], record["ownerId"], record["authorId"], record["subjectId"]}
			} else {
				projectIDs, statementIDs := []any{}, []any{}
				for _, v := range trustArray(item["sources"]) {
					r := psObject(v)
					projectIDs = append(projectIDs, r["projectId"])
					statementIDs = append(statementIDs, r["statementId"])
				}
				locator.Set("projectIds", projectIDs)
				locator.Set("statementIds", statementIDs)
				participants = []any{item["subjectId"]}
			}
			sourceRevision = helpHash(locator)
		}
		actual := []any{}
		for _, id := range participants {
			if helpSubject.MatchString(text(id)) {
				actual = append(actual, id)
			}
		}
		actual = helpUnique(actual)
		truncated := len(actual) > 16
		if truncated {
			actual = actual[:16]
		}
		classification := "source-record"
		if discovery || isOne(text(item["type"]), "opportunity", "worker", "hub") {
			classification = "self-declared"
		}
		ref := map[string]any{"key": helpHash([]any{l.scope.Endpoint, kind, item["id"], sourceRevision}), "kind": basisKind, "id": item["id"], "sourceRevision": sourceRevision, "locator": locator, "checkedAt": at, "classification": classification, "participantIds": actual, "capabilityVerified": false, "availability": "unknown"}
		if kind == "search-v2" || kind == "discovery-v2" {
			ref["participantIdsTruncated"] = truncated
		}
		if e = helpValidate("basis", ref); e != nil {
			return nil, nil, e
		}
		refs = append(refs, ref)
	}
	return page, refs, nil
}
func helpView(row map[string]any) map[string]any {
	out := psObject(psClone(row))
	keys := helpKnown(row)
	paths := []any{}
	offers := []any{}
	for _, path := range []string{"continue-current-ai", "capsule-or-history", "open-assistance", "bounty-or-expert"} {
		ids := []any{}
		for _, v := range trustArray(row["offers"]) {
			o := psObject(v)
			if o["path"] == path {
				ids = append(ids, o["id"])
			}
		}
		state := "no-concrete-option-known"
		if len(ids) > 0 {
			state = "options-described"
		}
		paths = append(paths, map[string]any{"path": path, "supported": true, "offerIds": ids, "state": state})
	}
	for _, v := range trustArray(out["offers"]) {
		o := psObject(v)
		status := "last-query-reference"
		for _, k := range helpStrings(o["basisKeys"]) {
			if !keys[k] {
				status = "refresh-required"
			}
		}
		o["sourceStatus"] = status
		o["semanticAccuracy"] = "user-agent-explanation-not-machine-certified"
		o["sourceRefreshRequiredBeforeAction"] = true
		offers = append(offers, o)
	}
	out["offers"] = offers
	out["paths"] = paths
	out["localOnly"] = true
	out["dataServiceProvidesModel"] = false
	out["activeEntries"] = []any{"match", "publish-task", "participate-in-task"}
	out["requestDefaults"] = map[string]any{"visibility": "Public", "disclosure": "reviewed-selected-summary", "automaticPublication": false}
	out["warnings"] = []any{"No result describes this visible query scope only.", "A source, selection or Capsule read is not successful reuse.", "Participant history does not establish willingness; paid eligibility is checked by Task operations."}
	return out
}
func (l *helpLease) query(ctx context.Context, id string, input map[string]any) (any, error) {
	if _, e := l.get(ctx, id); e != nil {
		return nil, e
	}
	results := []any{}
	seen := map[string]bool{}
	for _, v := range trustArray(input["requests"]) {
		request := psObject(v)
		requestID := text(request["requestId"])
		if seen[requestID] {
			return nil, helpError("help_operation_failed")
		}
		seen[requestID] = true
		page, refs, e := l.source(ctx, request)
		result := map[string]any{"requestId": request["requestId"], "kind": request["kind"], "checkedAt": l.host.now(), "basis": refs, "data": page}
		if e != nil {
			if check := l.check(ctx); check != nil {
				return nil, check
			}
			result["state"] = "failed"
			result["error"] = helpSourceError(e)
			result["basis"] = []any{}
			result["data"] = nil
		} else if len(trustArray(page["items"])) == 0 {
			result["state"] = "empty"
		} else {
			result["state"] = "ready"
		}
		results = append(results, result)
	}
	row, e := l.update(ctx, id, nil, func(draft map[string]any) error {
		queries := trustArray(draft["queries"])
		refs := trustArray(draft["basis"])
		for i, v := range results {
			r := psObject(v)
			basisKeys := []any{}
			for _, v := range trustArray(r["basis"]) {
				ref := psObject(v)
				basisKeys = append(basisKeys, ref["key"])
				refs = helpUpsert(refs, "key", ref)
			}
			q := map[string]any{"requestId": r["requestId"], "kind": r["kind"], "state": r["state"], "checkedAt": r["checkedAt"], "basisKeys": basisKeys, "request": trustArray(input["requests"])[i]}
			queries = helpUpsert(queries, "requestId", q)
		}
		if len(queries) > 32 {
			queries = queries[len(queries)-32:]
		}
		draft["queries"] = queries
		needed := map[string]bool{}
		for _, v := range append(append([]any{}, queries...), trustArray(draft["offers"])...) {
			for _, k := range helpStrings(psObject(v)["basisKeys"]) {
				needed[k] = true
			}
		}
		kept := []any{}
		for _, v := range refs {
			if needed[text(psObject(v)["key"])] {
				kept = append(kept, v)
			}
		}
		draft["basis"] = kept
		return nil
	})
	if e != nil {
		return nil, e
	}
	return map[string]any{"session": helpView(row), "results": results, "queryDoesNotPublish": true, "coverage": "requested-visible-pages-only"}, nil
}
func helpUpsert(rows []any, key string, row map[string]any) []any {
	for i, v := range rows {
		if psObject(v)[key] == row[key] {
			rows[i] = row
			return rows
		}
	}
	return append(rows, row)
}
