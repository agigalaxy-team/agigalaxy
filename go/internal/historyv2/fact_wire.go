package historyv2

import (
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"reflect"
)

// These are wire constructors for already authorized Case facts. They never
// decide visibility or read any event outside the Case owner's retained rows.
var baseKeys = []string{"id", "version", "caseId", "actorId", "reportedBy", "participationId", "taskId", "scopeVersion", "eventId", "caseVersion", "participationScopeVersion", "recordEventIds", "provenance", "claimAuthority", "synthetic"}

func sameJSON(a, b any) bool {
	normalize := func(v any) any {
		raw, e := protocol.EncodeJS(v)
		if e != nil {
			return nil
		}
		var out any
		if json.Unmarshal(raw, &out) != nil {
			return nil
		}
		return out
	}
	return reflect.DeepEqual(normalize(a), normalize(b))
}
func sourceNested(v, raw any) any {
	if raw != nil && sameJSON(v, raw) {
		return raw
	}
	return v
}
func refsWire(v any) any {
	out := []any{}
	for _, v := range arr(v) {
		out = append(out, fields(obj(v), "id", "version"))
	}
	return out
}
func responseWire(v any, rows map[string]Object) *ordered {
	o := obj(v)
	out := fields(o, "id", "actorId", "state", "summary", "interventionRef", "relationship", "recordEventIds")
	if raw := obj(rows[str(o, "id")]["payload"]); raw != nil {
		out.Set("interventionRef", sourceNested(o["interventionRef"], raw["interventionRef"]))
	}
	return out
}
func factWire(v any, kind string, rows map[string]Object) *ordered {
	o := obj(v)
	keys := append([]string{}, baseKeys...)
	switch kind {
	case "attempt":
		keys = append(keys, "strategy", "role", "configurationRef", "environment", "inputScopeSummary", "permissionScope", "status", "reportedOutcome", "startedAt", "endedAt", "resultRefs", "summary", "failureReason", "correction", "configurationCondition")
	case "intervention":
		keys = append(keys, "types", "description", "affectsAttemptIds", "affectsAttemptRefs", "sourceRefs", "observedEffect", "claimState", "confirmation", "responses", "capabilityVerified", "responseCoverage")
	case "result":
		keys = append(keys, "origin", "deliverableRefs", "reportedOutcome", "summary", "limitations", "acceptance", "verification", "supersedes")
	case "resolution":
		if o["id"] == nil {
			return fields(o, "status", "scopeVersion", "priorResolutionId", "currentSupport", "currentDecisionAvailable", "reconfirmationRequired", "summary")
		}
		keys = append(keys, "status", "summary", "satisfiedGoals", "remainingGoals", "resultRefs", "verificationRefs", "supersedesResolutionId", "decisionActor")
	}
	out := fields(o, keys...)
	raw := obj(rows[str(o, "eventId")]["payload"])
	initial := obj(rows[str(o, "id")]["payload"])
	for _, k := range []string{"origin", "deliverableRefs", "sourceRefs", "supersedes", "resultRefs", "verificationRefs"} {
		if v, ok := o[k]; ok {
			if k == "resultRefs" && kind == "attempt" {
				out.Set(k, refsWire(v))
			} else if candidate := raw[k]; candidate != nil {
				out.Set(k, sourceNested(v, candidate))
			}
		}
	}
	if kind == "result" && raw["origin"] == nil {
		out.Set("origin", fields(obj(o["origin"]), "kind", "id", "version"))
	}
	if kind == "attempt" {
		for _, k := range []string{"environment", "configurationRef"} {
			if v, ok := o[k]; ok {
				candidate := initial[k]
				if k == "environment" && candidate == nil {
					candidate = initial["configuration"]
				}
				out.Set(k, sourceNested(v, candidate))
			}
		}
		if c := obj(o["correction"]); c != nil {
			out.Set("correction", build("reason", c["reason"], "supersedes", sourceNested(c["supersedes"], raw["attemptRef"])))
		}
		if c := obj(o["configurationCondition"]); c != nil {
			if c["id"] != nil {
				out.Set("configurationCondition", fields(c, "id", "version", "subjectId", "sourceStatus", "record", "contentAvailable", "actualInstallationVerified", "unknownFieldsMeaning", "management", "disclosure", "reference", "conditionsKnown", "meaning"))
			} else {
				out.Set("configurationCondition", fields(c, "reference", "sourceStatus", "record", "conditionsKnown", "meaning"))
			}
		}
	}
	if kind == "intervention" {
		out.Set("affectsAttemptRefs", refsWire(o["affectsAttemptRefs"]))
		responses := []any{}
		for _, r := range arr(o["responses"]) {
			responses = append(responses, responseWire(r, rows))
		}
		out.Set("responses", responses)
		if c := obj(o["responseCoverage"]); c != nil {
			out.Set("responseCoverage", fields(c, "mode", "complete"))
		}
	}
	return out
}
func factVersions(v any, kind string, rows map[string]Object) []any {
	versions := map[string]int64{}
	for _, f := range arr(v) {
		o := obj(f)
		if n := num(o, "version"); n > versions[str(o, "id")] {
			versions[str(o, "id")] = n
		}
	}
	out := []any{}
	for _, f := range arr(v) {
		o := obj(f)
		wire := visible(factWire(f, kind, rows)).(*ordered)
		wire.Set("currentVisibleVersion", versions[str(o, "id")])
		wire.Set("supersededInVisibleHistory", num(o, "version") < versions[str(o, "id")])
		wire.Set("capabilityVerified", false)
		out = append(out, wire)
	}
	return out
}
