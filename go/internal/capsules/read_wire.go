package capsules

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func sourceRefWire(v any) any {
	if v == nil {
		return nil
	}
	return orderedFields(obj(v), "kind", "id", "version", "caseId")
}
func attributionWire(v any) any {
	o := obj(v)
	out := orderedFields(o, "subjectId", "source", "authority", "contributionResponses", "coauthorApproval")
	out.Set("source", sourceRefWire(o["source"]))
	r := obj(o["contributionResponses"])
	responses := []any{}
	for _, v := range list(r["responses"]) {
		response := obj(v)
		x := orderedFields(response, "eventId", "actorId", "relationship", "state", "interventionRef")
		if ref := obj(response["interventionRef"]); ref != nil {
			x.Set("interventionRef", orderedFields(ref, "id", "version"))
		}
		responses = append(responses, x)
	}
	rw := orderedFields(r, "meaning", "coverage", "coauthorApproval", "status", "source", "taskId", "confirmation", "responses")
	if r["source"] != nil {
		rw.Set("source", sourceRefWire(r["source"]))
	}
	rw.Set("responses", responses)
	out.Set("contributionResponses", rw)
	return out
}

// ReadV2WireWithin preserves original current read DTO order after the complete
// owning version/source/permission checks. It is not a new entry authorization.
func (s *Service) ReadV2WireWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (json.RawMessage, error) {
	o, e := s.ReadV2Within(ctx, tx, a, input)
	if e != nil {
		return nil, e
	}
	var out *protocol.OrderedObject
	if o["version"] == nil {
		out = orderedFields(o, "capsuleId", "versionId", "ownerControl", "version", "sourceStatus", "reason", "authorId", "revision", "deprecated", "securityIssue", "notices", "newApplicationAllowed", "capabilityVerified")
	} else {
		out = orderedFields(o, "capsuleId", "versionId", "authorId", "version", "ownerControl", "revision", "sourceStatus", "permissions", "attributions", "sourceReading", "deprecated", "securityIssue", "notices", "newApplicationAllowed", "synthetic", "compatibility", "readingIsReuse", "coauthorApproval", "capabilityVerified")
		permissions := []any{}
		for _, v := range list(o["permissions"]) {
			permissions = append(permissions, orderedFields(obj(v), "permissionId", "authorId", "license", "scope", "basis", "attribution", "licenseReference", "status", "coauthorApproval", "legalOwnershipIndependentlyVerified"))
		}
		out.Set("permissions", permissions)
		attrs := []any{}
		for _, v := range list(o["attributions"]) {
			attrs = append(attrs, attributionWire(v))
		}
		out.Set("attributions", attrs)
		if reading := obj(o["sourceReading"]); reading != nil {
			r := protocol.NewOrderedObject()
			for _, key := range []string{"case", "result"} {
				x := obj(reading[key])
				var wire *protocol.OrderedObject
				if key == "case" {
					wire = orderedFields(x, "status", "ref", "authorId", "title", "summary")
				} else {
					wire = orderedFields(x, "status", "ref", "authorId", "summary", "reportedOutcome", "limitations", "currentness")
				}
				if x["ref"] != nil {
					wire.Set("ref", sourceRefWire(x["ref"]))
				}
				r.Set(key, wire)
			}
			out.Set("sourceReading", r)
		}
	}
	if control := obj(o["ownerControl"]); control != nil {
		out.Set("ownerControl", orderedFields(control, "type", "operationId", "consentId", "payloadHash"))
	}
	raw, e := protocol.EncodeJS(out)
	return json.RawMessage(raw), e
}
