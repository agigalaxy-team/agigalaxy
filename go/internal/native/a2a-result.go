package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

func (h *NativeA2a) prepareResult(ctx context.Context, peer a2aPeer, l *nativeIdentityLease, j *a2aJournal, input map[string]any) (*A2aPreview, error) {
	id := text(input["associationId"])
	link, e := j.get(ctx, id)
	if e != nil {
		return nil, e
	}
	_, current, _, e := h.access(ctx, peer, l, link, nil)
	if e != nil {
		return nil, e
	}
	saved := uploadObject(link["resultImportV2"])
	if saved == nil {
		observation := uploadObject(link["peer"])
		if !a2aTerminal(text(observation["state"])) {
			return nil, a2aError("terminal peer observation required")
		}
		outcome := text(input["reportedOutcome"])
		if observation["state"] != "completed" && (outcome == "succeeded" || outcome == "partial") {
			return nil, a2aError("peer state cannot support success report")
		}
		facts := uploadObject(link["factContext"])
		event := map[string]any{"schemaVersion": 2, "kind": "result-recorded", "eventId": uuid.NewString(), "caseId": link["caseId"], "expectedVersion": current["version"], "actorId": l.scope.Owner, "origin": facts["origin"], "scopeVersion": facts["scopeVersion"], "deliverableRefs": []any{}, "reportedOutcome": outcome, "summary": uploadTrim(text(input["summary"])), "limitations": uploadTrim(fmt.Sprintf("External A2A participant report; no independent Verification, acceptance or Resolution. Association %s; response SHA256 %s; artifacts remain selected summaries/hashes in the private local journal. %s", id, text(observation["responseHash"]), text(input["limitations"])))}
		if facts["taskId"] != nil {
			event["taskId"] = facts["taskId"]
			event["taskScopeVersion"] = facts["scopeVersion"]
		}
		if facts["participationId"] != nil {
			event["participationId"] = facts["participationId"]
			event["participationScopeVersion"] = facts["participationScopeVersion"]
		}
		var schema map[string]any
		_ = protocol.Decode([]byte(a2aResultSchemaJSON), &schema)
		if remoteChatValidate(schema, event) != nil {
			return nil, a2aError("invalid Result selection")
		}
		var order []string
		_ = protocol.Decode([]byte(a2aResultFieldOrderJSON), &order)
		wire := protocol.NewOrderedObject()
		for _, key := range order {
			if value, ok := event[key]; ok {
				if key == "origin" {
					o := uploadObject(value)
					origin := protocol.NewOrderedObject()
					for _, k := range []string{"kind", "id", "version"} {
						origin.Set(k, o[k])
					}
					value = origin
				}
				wire.Set(key, value)
			}
		}
		raw, e := protocol.EncodeJS(wire)
		if e != nil {
			return nil, e
		}
		scope := peer.scope(l.scope.Owner, h.runtime.config.Endpoint)
		ops := uploadRows(link["operations"])
		if len(ops) == 0 {
			return nil, a2aError("original peer observation unavailable")
		}
		source := map[string]any{"subjectId": scope.SubjectID, "officialEndpoint": scope.OfficialEndpoint, "endpoint": scope.Endpoint, "tenant": scope.Tenant, "peerPrincipal": scope.PeerPrincipal, "taskId": observation["taskId"], "contextId": observation["contextId"], "responseHash": observation["responseHash"], "observedAt": uploadObject(ops[len(ops)-1])["at"], "verification": "peer-reported"}
		draft := map[string]any{"associationId": id, "source": source, "event": event}
		saved = map[string]any{"draft": draft, "payloadJson": string(raw), "payloadHash": a2aHash(raw), "sourceHash": observation["responseHash"], "state": "prepared"}
		link, e = j.change(ctx, id, a2aInteger(link["revision"]), func(dir string) error { return h.guard(l, dir) }, func(previous map[string]any) (map[string]any, error) {
			next := a2aClone(previous)
			next["resultImportV2"] = saved
			return next, nil
		})
		if e != nil {
			return nil, e
		}
	}
	draft := uploadObject(saved["draft"])
	if saved["state"] == "acknowledged" {
		return &A2aPreview{host: h, lease: l, state: "completed", value: map[string]any{"state": "acknowledged", "receipt": saved["receipt"]}}, nil
	}
	authorization := uploadObject(saved["authorization"])
	if authorization == nil {
		authorization = map[string]any{"requestId": uuid.NewString(), "action": "case.teaser.publish", "objectId": uploadObject(draft["event"])["eventId"], "payloadJson": saved["payloadJson"], "visibility": input["visibility"], "viewers": input["viewers"]}
		if input["expiresAt"] != nil {
			authorization["expiresAt"] = input["expiresAt"]
		}
		link, e = j.change(ctx, id, a2aInteger(link["revision"]), func(dir string) error { return h.guard(l, dir) }, func(previous map[string]any) (map[string]any, error) {
			next := a2aClone(previous)
			s := a2aClone(uploadObject(next["resultImportV2"]))
			s["authorization"] = authorization
			next["resultImportV2"] = s
			return next, nil
		})
		if e != nil {
			return nil, e
		}
	}
	preview := &A2aPreview{host: h, peer: peer, lease: l, journal: j, link: link, value: map[string]any{"kind": "result", "associationId": id, "draft": draft, "authorization": authorization}, action: "result", operationID: text(uploadObject(draft["event"])["eventId"]), state: "prepared", expires: h.options.Now().UnixMilli() + 300000}
	if e = l.check(ctx); e != nil {
		return nil, e
	}
	return h.keepPreview(preview)
}
func (h *NativeA2a) recordResult(ctx context.Context, l *nativeIdentityLease, j *a2aJournal, id string, receipt map[string]any) (map[string]any, error) {
	link, e := j.get(ctx, id)
	if e != nil {
		return nil, e
	}
	saved := uploadObject(link["resultImportV2"])
	event := uploadObject(uploadObject(saved["draft"])["event"])
	if event == nil || receipt["caseId"] != event["caseId"] || receipt["eventId"] != event["eventId"] || a2aInteger(receipt["version"]) != a2aInteger(event["expectedVersion"])+1 || receipt["claimAuthority"] != "participant-reported" || receipt["verification"] != "not-provided" || receipt["acceptance"] != "not-provided" || receipt["resolution"] != "separate" {
		return nil, a2aError("Result receipt mismatch")
	}
	_, e = j.change(ctx, id, a2aInteger(link["revision"]), func(dir string) error { return h.guard(l, dir) }, func(previous map[string]any) (map[string]any, error) {
		next := a2aClone(previous)
		s := a2aClone(uploadObject(next["resultImportV2"]))
		s["state"] = "acknowledged"
		s["receipt"] = receipt
		next["resultImportV2"] = s
		return next, nil
	})
	return receipt, e
}
func (h *NativeA2a) reconcileResult(ctx context.Context, l *nativeIdentityLease, j *a2aJournal, id string) (map[string]any, error) {
	link, e := j.get(ctx, id)
	if e != nil {
		return nil, e
	}
	saved := uploadObject(link["resultImportV2"])
	if saved == nil {
		return map[string]any{"state": "not-prepared"}, nil
	}
	event := uploadObject(uploadObject(saved["draft"])["event"])
	accepted, e := l.call(ctx, "/v2/cases/events/receipt", map[string]any{"caseId": link["caseId"], "eventId": event["eventId"], "payloadHash": saved["payloadHash"]}, false)
	if e != nil {
		return nil, e
	}
	if accepted["caseId"] != link["caseId"] || accepted["eventId"] != event["eventId"] || accepted["payloadHash"] != saved["payloadHash"] || accepted["authority"] != "accepted-operation-only" || accepted["currentAccessGranted"] != false {
		return nil, a2aError("Result reconciliation conflict")
	}
	if accepted["state"] == "absent" {
		return map[string]any{"state": "absent", "originalOperationRetained": true, "authority": accepted["authority"], "currentAccessGranted": false}, nil
	}
	if accepted["state"] != "acknowledged" || a2aInteger(accepted["caseVersion"]) != a2aInteger(event["expectedVersion"])+1 || accepted["verification"] != "not-provided" || accepted["acceptance"] != "not-provided" || accepted["resolution"] != "separate" {
		return nil, a2aError("Result reconciliation conflict")
	}
	receipt := map[string]any{"caseId": event["caseId"], "eventId": event["eventId"], "version": accepted["caseVersion"], "caseVersion": accepted["caseVersion"], "objectRef": map[string]any{"id": event["eventId"], "version": 1}, "claimAuthority": "participant-reported", "verification": "not-provided", "acceptance": "not-provided", "resolution": "separate", "authority": accepted["authority"], "currentAccessGranted": false}
	if _, e = h.recordResult(ctx, l, j, id, receipt); e != nil {
		return nil, e
	}
	return map[string]any{"state": "acknowledged", "receipt": receipt, "authority": accepted["authority"], "currentAccessGranted": false}, nil
}
func (h *NativeA2a) executeResult(ctx context.Context, p *A2aPreview) (map[string]any, error) {
	id := text(p.value["associationId"])
	result, e := h.reconcileResult(ctx, p.lease, p.journal, id)
	if e != nil {
		return nil, e
	}
	if result["state"] == "acknowledged" {
		return uploadObject(result["receipt"]), nil
	}
	if result["state"] != "absent" {
		return nil, a2aError("original Result unavailable")
	}
	link, e := p.journal.get(ctx, id)
	if e != nil {
		return nil, e
	}
	if _, _, _, e = h.access(ctx, p.peer, p.lease, link, nil); e != nil {
		return nil, e
	}
	auth := uploadObject(p.value["authorization"])
	authorized, e := h.runtime.AuthorizeReviewed(ctx, auth, &p.lease.scope)
	if e != nil {
		return nil, e
	}
	if e = p.lease.check(ctx); e != nil {
		return nil, e
	}
	receipt, e := p.lease.call(ctx, "/v2/cases/events", map[string]any{"consentId": authorized["consentId"], "payloadJson": auth["payloadJson"]}, false)
	if e != nil {
		return nil, e
	}
	if _, e = h.recordResult(ctx, p.lease, p.journal, id, receipt); e != nil {
		return nil, e
	}
	out := a2aClone(receipt)
	out["externalSource"] = uploadObject(p.value["draft"])["source"]
	return out, nil
}
