package cases

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"time"
)

func reference(v any, source bool) bool {
	o := object(v)
	req := []string{"id", "version"}
	if source {
		req = append(req, "kind")
	}
	return shape(o, req, nil) && uuidField(o, "id") && integer(o, "version", 1) && (!source || one(o["kind"], "attempt", "intervention", "result", "evidence", "selected-message", "configuration", "outcome-material"))
}
func references(v any, source bool) bool {
	a, ok := v.([]any)
	if !ok || len(a) > 32 {
		return false
	}
	for _, r := range a {
		if !reference(r, source) {
			return false
		}
	}
	return true
}
func dateField(o Object, k string) bool {
	s, ok := o[k].(string)
	if !ok || len(s) < 16 || s[len(s)-1] != 'Z' {
		return false
	}
	_, e := time.Parse(time.RFC3339Nano, s)
	return e == nil
}
func parseFact(raw string) (Object, error) {
	invalid := func() (Object, error) { return nil, fault.New("invalid_case_v2_payload", 400) }
	if len(raw) > 24000 {
		return invalid()
	}
	var o Object
	if protocol.Decode([]byte(raw), &o) != nil {
		return invalid()
	}
	required := []string{"kind", "eventId", "caseId", "expectedVersion", "actorId"}
	optional := []string{"schemaVersion", "taskId", "participationId", "taskScopeVersion", "participationScopeVersion"}
	kind := text(o, "kind")
	switch kind {
	case "case-created":
		required = append(required, "localRef", "title", "summary", "source", "synthetic")
	case "attempt-start":
		required = append(required, "role", "strategy", "inputScopeSummary", "permissionScope")
		optional = append(optional, "configurationRef", "environment", "startedAt")
	case "attempt-end":
		required = append(required, "attemptRef", "status", "summary", "failureReason")
		optional = append(optional, "reportedOutcome", "endedAt")
	case "attempt-correct":
		required = append(required, "attemptRef", "status", "summary", "failureReason", "reason")
		optional = append(optional, "reportedOutcome")
	case "intervention":
		required = append(required, "types", "affectsAttemptIds", "description", "sourceRefs", "observedEffect")
		optional = append(optional, "supersedes")
	case "intervention-response":
		required = append(required, "interventionRef", "state", "summary")
	case "result-recorded":
		required = append(required, "origin", "scopeVersion", "deliverableRefs", "reportedOutcome", "summary", "limitations")
		optional = append(optional, "supersedes")
	case "resolution-recorded":
		required = append(required, "status", "summary", "satisfiedGoals", "remainingGoals", "resultRefs", "verificationRefs", "supersedesResolutionId")
		required = append(required, "taskScopeVersion")
	case "case-scope-revised":
		required = append(required, "taskScopeVersion", "summary", "reason")
	case "case-withdrawn":
		required = append(required, "reason")
	default:
		return invalid()
	}
	if !shape(o, required, optional) || !uuidField(o, "eventId") || !uuidField(o, "caseId") || !subjectPattern.MatchString(text(o, "actorId")) {
		return invalid()
	}
	if kind == "case-created" {
		if !integer(o, "expectedVersion", 0) || number(o, "expectedVersion") != 0 {
			return invalid()
		}
	} else if !integer(o, "expectedVersion", 1) {
		return invalid()
	}
	if _, ok := o["schemaVersion"]; ok && (!integer(o, "schemaVersion", 2) || number(o, "schemaVersion") != 2) {
		return invalid()
	}
	for _, k := range []string{"taskId", "participationId"} {
		if v, ok := o[k]; ok && v != nil && !uuidField(o, k) {
			return invalid()
		}
	}
	for _, k := range []string{"taskScopeVersion", "participationScopeVersion", "scopeVersion"} {
		if _, ok := o[k]; ok && !integer(o, k, 1) {
			return invalid()
		}
	}
	for _, k := range []string{"configurationRef", "supersedes"} {
		if v, ok := o[k]; ok && v != nil && !reference(v, false) {
			return invalid()
		}
	}
	for _, k := range []string{"startedAt", "endedAt"} {
		if _, ok := o[k]; ok && !dateField(o, k) {
			return invalid()
		}
	}
	if _, ok := o["reportedOutcome"]; ok && !one(o["reportedOutcome"], "succeeded", "partial", "failed", "inconclusive", "conflicting") {
		return invalid()
	}
	valid := true
	for _, k := range []string{"strategy", "inputScopeSummary", "summary", "failureReason", "reason", "description", "observedEffect", "limitations"} {
		if _, ok := o[k]; ok {
			valid = valid && bounded(o, k, 1, 1200, true)
		}
	}
	switch kind {
	case "case-created":
		source := object(o["source"])
		_, synthetic := o["synthetic"].(bool)
		valid = valid && refPattern.MatchString(text(o, "localRef")) && bounded(o, "title", 1, 160, true) && shape(source, []string{"kind", "reference"}, nil) && one(source["kind"], "local", "bridge", "hub", "active-task") && refPattern.MatchString(text(source, "reference")) && synthetic
	case "attempt-start":
		valid = valid && bounded(o, "role", 1, 120, false) && stringsList(o["permissionScope"], 1, 32, 160)
		if v, ok := o["environment"]; ok {
			e := object(v)
			valid = valid && shape(e, []string{"name", "version"}, nil) && bounded(e, "name", 1, 160, false) && bounded(e, "version", 1, 80, false)
		}
	case "attempt-end", "attempt-correct":
		valid = valid && reference(o["attemptRef"], false) && one(o["status"], "completed", "abandoned", "canceled", "inconclusive")
	case "intervention":
		types, ok := o["types"].([]any)
		valid = valid && ok && len(types) >= 1 && len(types) <= 12
		for _, v := range types {
			valid = valid && one(v, "diagnosis", "advice", "context-addition", "tool-introduction", "patch", "review", "takeover", "verification", "scope-clarification", "multi-node-collaboration")
		}
		ids, ok := o["affectsAttemptIds"].([]any)
		valid = valid && ok && len(ids) <= 32
		for _, id := range ids {
			s, _ := id.(string)
			valid = valid && uuidPattern.MatchString(s)
		}
		valid = valid && references(o["sourceRefs"], true)
	case "intervention-response":
		valid = valid && reference(o["interventionRef"], false) && one(o["state"], "accepted", "partial", "disputed")
	case "result-recorded":
		origin := object(o["origin"])
		valid = valid && reference(origin, true) && one(origin["kind"], "attempt", "intervention") && references(o["deliverableRefs"], true)
	case "resolution-recorded":
		valid = valid && one(o["status"], "unresolved", "partially-resolved", "resolved", "inconclusive", "regressed") && references(o["resultRefs"], false) && references(o["verificationRefs"], false)
		if o["supersedesResolutionId"] != nil {
			valid = valid && uuidField(o, "supersedesResolutionId")
		}
		for _, k := range []string{"satisfiedGoals", "remainingGoals"} {
			a, ok := o[k].([]any)
			valid = valid && ok && len(a) <= 32
			for i, v := range a {
				tmp := Object{"text": v}
				valid = valid && bounded(tmp, "text", 1, 1200, true)
				a[i] = tmp["text"]
			}
		}
	}
	if !valid {
		return invalid()
	}
	return o, nil
}
