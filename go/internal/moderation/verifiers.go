package moderation

import "github.com/agigalaxy-team/agigalaxy/go/internal/protocol"

var verifierKinds = []string{"invite-verifier", "accept-verifier", "decline-verifier", "withdraw-verifier", "verification-response"}

func verifierTarget(report Object) Object {
	if report["caseId"] != nil {
		out := Object{"caseId": report["caseId"], "caseVersion": report["caseVersion"], "targetEventId": report["targetEventId"]}
		if v, ok := report["evidenceId"]; ok {
			out["evidenceId"] = v
		}
		return out
	}
	return Object{"assistanceId": report["assistanceId"]}
}

// ProjectVerifiers retains the original immutable accepted event projection.
// Surviving self-authored participation does not grant missing invitation scope.
func ProjectVerifiers(events []Object) []Object {
	order := []string{}
	members := map[string]Object{}
	for _, row := range events {
		event := obj(row, "parsedPayload")
		if event == nil {
			continue
		}
		kind := str(event, "kind")
		if kind == "invite-verifier" {
			id := str(event, "verifierId")
			prior := members[id]
			if prior == nil {
				order = append(order, id)
			}
			members[id] = Object{"subjectId": id, "invitationId": event["id"], "inviterId": row["subject_id"], "expiresAt": event["expiresAt"], "status": "invited", "participated": truth(prior, "participated")}
		} else if has(verifierKinds, kind) {
			id := str(row, "subject_id")
			member := members[id]
			if member == nil && has([]string{"accept-verifier", "withdraw-verifier", "verification-response"}, kind) {
				member = Object{"subjectId": id, "invitationId": event["invitationId"], "inviterId": nil, "expiresAt": nil, "status": "accepted", "participated": true, "invitationAvailable": false}
				members[id] = member
				order = append(order, id)
			}
			if member == nil || member["invitationId"] != event["invitationId"] {
				continue
			}
			switch kind {
			case "accept-verifier":
				member["status"], member["participated"] = "accepted", true
			case "decline-verifier":
				member["status"] = "declined"
			case "withdraw-verifier":
				member["status"] = "withdrawn"
			case "verification-response":
				member["responseEventId"] = event["id"]
			}
		}
	}
	out := []Object{}
	for _, id := range order {
		out = append(out, members[id])
	}
	return out
}
func parties(r Object) []string {
	out := append([]string{str(r, "reporter_id")}, stringsOf(r["participant_ids"])...)
	for _, v := range objectsOf(r["verifiers"]) {
		if truth(v, "participated") {
			out = append(out, str(v, "subjectId"))
		}
	}
	return unique(out)
}
func verifier(r Object, subject string) Object {
	for _, v := range objectsOf(r["verifiers"]) {
		if v["subjectId"] == subject {
			return v
		}
	}
	return nil
}
func targetBytes(x Object) []byte {
	o := protocol.NewOrderedObject()
	keys := []string{"assistanceId"}
	if x["caseId"] != nil {
		keys = []string{"caseId", "caseVersion", "targetEventId", "evidenceId"}
	}
	for _, key := range keys {
		if v, ok := x[key]; ok {
			o.Set(key, v)
		}
	}
	b, _ := protocol.EncodeJS(o)
	return b
}
func verifierTransition(r Object, actor string, event Object, now int64, independent bool) error {
	own := verifier(r, actor)
	if event["kind"] == "invite-verifier" {
		prior := verifier(r, str(event, "verifierId"))
		if !independent || event["verifierId"] == actor || has(parties(r), str(event, "verifierId")) && !truth(prior, "participated") {
			return fail("moderation_role_denied", 403)
		}
		if prior != nil && (prior["status"] == "accepted" || prior["status"] == "invited" && num(prior, "expiresAt") > now) {
			return fail("verifier_already_invited", 409)
		}
		if prior == nil && len(objectsOf(r["verifiers"])) >= 4 {
			return fail("verifier_invitation_limit", 429)
		}
		if num(event, "expiresAt") <= now || num(event, "expiresAt") > now+604800 {
			return fail("verifier_invitation_expiry", 409)
		}
		report := obj(r, "reportData")
		if report == nil {
			return fail("moderation_source_unavailable", 409)
		}
		if string(targetBytes(obj(event, "target"))) != string(targetBytes(verifierTarget(report))) {
			return fail("verifier_target_mismatch", 409)
		}
		return nil
	}
	if own == nil || own["invitationId"] != event["invitationId"] {
		return fail("verifier_invitation_required", 403)
	}
	expected := "accepted"
	if has([]string{"accept-verifier", "decline-verifier"}, str(event, "kind")) {
		expected = "invited"
	}
	if own["status"] != expected {
		return fail("verifier_transition_denied", 409)
	}
	if event["kind"] == "accept-verifier" && num(own, "expiresAt") <= now {
		return fail("verifier_invitation_expired", 409)
	}
	return nil
}
