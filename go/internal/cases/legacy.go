package cases

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func legacyReceipt(cid, id string, version int64) Object {
	return Object{"caseId": cid, "eventId": id, "version": version, "verification": "unverified"}
}
func (s *Service) Submit(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	consent, payload, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	event, e := parseLegacy(payload)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, event["kind"] == "withdrawal", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		return s.submitLegacyWithin(ctx, tx, a, event, consent, payload, requestID, auth)
	})
}
func (s *Service) submitLegacyWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, event Object, consent, payload, requestID string, auth deviceauth.ControlAuthorization) (Object, error) {
	cid := text(event, "caseId")
	id, kind := text(event, "id"), text(event, "kind")
	if kind == "case" {
		cid = id
		requester := false
		for _, p := range list(event["participants"]) {
			p := object(p)
			requester = requester || p["subjectId"] == a.SubjectID && p["role"] == "requester"
		}
		if !requester {
			return nil, fault.New("requester_required", 403)
		}
		if _, e := tx.Exec(ctx, `INSERT INTO cases(id,subject_id,local_ref,source_ref,version,state) VALUES($1,$2,$3,$4,1,'open') ON CONFLICT DO NOTHING`, cid, a.SubjectID, event["localRef"], object(event["source"])["reference"]); e != nil {
			return nil, e
		}
	}
	parent, e := queryOne(ctx, tx, `SELECT id::text,subject_id,version,state FROM cases WHERE id=$1 AND subject_id=$2 FOR UPDATE`, cid, a.SubjectID)
	if e != nil {
		return nil, e
	}
	if parent == nil {
		return nil, fault.New("case_conflict_or_not_found", 409)
	}
	if _, e = s.grant(ctx, tx, Object{"id": id, "subject_id": a.SubjectID, "consent_id": consent, "payload_text": payload}); e != nil {
		return nil, e
	}
	existing, e := queryOne(ctx, tx, `SELECT id::text,case_id::text,subject_id,payload_hash,consent_id::text,version FROM case_events WHERE id=$1`, id)
	if e != nil {
		return nil, e
	}
	hash := identity.Digest([]byte(payload))
	if existing != nil {
		if existing["subject_id"] != a.SubjectID || existing["case_id"] != cid || existing["payload_hash"] != hash || existing["consent_id"] != consent {
			return nil, fault.New("event_conflict", 409)
		}
		return legacyReceipt(cid, id, number(existing, "version")), nil
	}
	rows, e := events(ctx, tx, cid)
	if e != nil {
		return nil, e
	}
	for _, r := range rows {
		if !one(r["kind"], "case", "attempt", "result", "revision", "withdrawal") {
			return nil, fault.New("unsupported_semantics", 409)
		}
	}
	if parent["state"] == "withdrawn" {
		return nil, fault.New("case_withdrawn", 409)
	}
	version := int64(1)
	if kind != "case" {
		if number(parent, "version") != number(event, "expectedVersion") {
			return nil, fault.New("version_conflict", 409)
		}
		if number(parent, "version") >= 1000 {
			return nil, fault.New("case_event_limit", 413)
		}
		version = number(parent, "version") + 1
	}
	if kind == "attempt" {
		count := int64(0)
		for _, r := range rows {
			if r["kind"] == "attempt" {
				count++
			}
		}
		if number(event, "sequence") != count+1 {
			return nil, fault.New("attempt_order_conflict", 409)
		}
	}
	if kind == "result" || kind == "revision" {
		ref := text(event, "correctsEventId")
		if kind == "result" {
			ref = text(event, "attemptId")
		}
		var referenced Object
		for _, r := range rows {
			if r["id"] == ref {
				referenced = r
				break
			}
		}
		if referenced == nil || kind == "result" && referenced["kind"] != "attempt" {
			return nil, fault.New("invalid_case_reference", 400)
		}
		if kind == "result" && event["outcome"] == "failed" && trimJS(text(event, "failureReason")) == "" {
			return nil, fault.New("failure_reason_required", 400)
		}
	}
	if kind == "revision" && event["review"] != nil {
		if e = assertReview(event, rows); e != nil {
			return nil, e
		}
	}
	if _, e = tx.Exec(ctx, `INSERT INTO case_events(id,case_id,subject_id,kind,version,consent_id,payload,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, id, cid, a.SubjectID, kind, version, consent, string(encode(event)), payload, hash); e != nil {
		return nil, e
	}
	state := parent["state"]
	if kind == "withdrawal" {
		state = "withdrawn"
	} else if kind == "result" && event["outcome"] == "succeeded" {
		state = "resolution-proposed"
	}
	if _, e = tx.Exec(ctx, `UPDATE cases SET version=$2,state=$3 WHERE id=$1`, cid, version, state); e != nil {
		return nil, e
	}
	if e = s.audit(ctx, tx, a, auth, kind, cid, id, requestID); e != nil {
		return nil, e
	}
	return legacyReceipt(cid, id, version), nil
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, kind, cid, id, requestID string) error {
	var rid any
	if requestID != "" {
		rid = requestID
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
SELECT $1,$2,$3::text,$4::text,'accepted',1,ch.payload->>'installationId',b.audience,'case-teaser',c.id,b.id,$5,$4::text,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
FROM case_events e JOIN consents c ON c.id=e.consent_id JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
WHERE e.id=$4::text::uuid AND e.case_id=$3::text::uuid AND e.subject_id=$1 AND c.subject_id=$1 AND b.subject_id=$1`, a.SubjectID, "case."+kind, cid, id, rid, string(encode(auth.CredentialScopes)), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("case audit context unavailable")
	}
	return nil
}
func assertReview(event Object, rows []Object) error {
	r := object(event["review"])
	history := []Object{}
	for _, row := range rows {
		p := object(row["payload"])
		if p["kind"] == "revision" && object(p["review"])["threadId"] == r["threadId"] {
			history = append(history, p)
		}
	}
	if len(history) == 0 {
		if r["threadId"] != event["id"] || r["state"] != "opened" {
			return fault.New("review_open_required", 409)
		}
		return nil
	}
	first, last := history[0], history[len(history)-1]
	if r["type"] != object(first["review"])["type"] || event["correctsEventId"] != first["correctsEventId"] {
		return fault.New("review_target_conflict", 409)
	}
	transitions := map[string][]string{"opened": {"in-review", "resolved", "rejected"}, "in-review": {"resolved", "rejected"}, "resolved": {"reopened"}, "rejected": {"reopened"}, "reopened": {"in-review", "resolved", "rejected"}}
	for _, state := range transitions[text(object(last["review"]), "state")] {
		if r["state"] == state {
			return nil
		}
	}
	return fault.New("review_transition_conflict", 409)
}
func reviews(rows []Object) []any {
	all := []any{}
	threads := map[string]Object{}
	for _, row := range rows {
		p := object(row["payload"])
		r := object(p["review"])
		if p["kind"] != "revision" || r == nil {
			continue
		}
		id := text(r, "threadId")
		t := threads[id]
		if t == nil {
			t = Object{"threadId": id, "type": r["type"], "targetEventId": p["correctsEventId"], "authority": "case-owner-reported", "independentDecision": false, "changes": []any{}}
			threads[id] = t
			all = append(all, t)
		}
		t["state"] = r["state"]
		t["changes"] = appended(t["changes"], Object{"eventId": p["id"], "state": r["state"], "reason": p["reason"], "summary": p["summary"]})
	}
	return all
}
func (s *Service) Get(ctx context.Context, a deviceauth.Actor, id string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		parent, e := queryOne(ctx, tx, `SELECT id::text,subject_id,version,state FROM cases WHERE id=$1 AND subject_id=$2 FOR SHARE`, id, a.SubjectID)
		if e != nil {
			return nil, e
		}
		if parent == nil {
			return nil, fault.New("not_found", 404)
		}
		rows, e := events(ctx, tx, id)
		if e != nil {
			return nil, e
		}
		for _, r := range rows {
			if !one(r["kind"], "case", "attempt", "result", "revision", "withdrawal") {
				return nil, fault.New("unsupported_semantics", 409)
			}
		}
		if len(rows) > 1000 {
			return nil, fault.New("case_event_limit", 413)
		}
		out := []any{}
		for _, r := range rows {
			if _, e = s.grant(ctx, tx, r); e != nil {
				return nil, e
			}
			p := copyObject(object(r["payload"]))
			v := Object{"version": r["version"]}
			for k, x := range p {
				v[k] = x
			}
			out = append(out, v)
		}
		result := Object{"caseId": id, "version": parent["version"], "state": parent["state"], "verification": "unverified", "reviews": reviews(rows), "events": out}
		if s.CapsuleUses != nil {
			uses, e := s.CapsuleUses(ctx, tx, a, id)
			if e != nil {
				return nil, e
			}
			if len(list(uses["items"])) > 0 {
				result["capsuleUses"] = uses
			}
		}
		return result, nil
	})
}
