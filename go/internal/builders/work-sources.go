package builders

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) nodeControl(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, b loadedBuilder, current Object) (Object, error) {
	state := "not-applicable"
	if current["type"] == "worker" {
		state = "unverified"
	}
	base := Object{"state": state, "capabilityVerified": false, "endpointControlVerified": false}
	if current["type"] != "worker" {
		return base, nil
	}
	var control Object
	for _, row := range b.rows {
		if row["kind"] == "node-control" && event(row)["declarationId"] == b.declaration["id"] {
			control = row
		}
	}
	if control == nil {
		return base, nil
	}
	for _, row := range b.rows {
		if row["kind"] == "node-control-revoke" && event(row)["controlId"] == control["id"] {
			base["state"] = "revoked"
			return base, nil
		}
	}
	g, e := s.grant(ctx, tx, control, false)
	if e != nil {
		if missing(e) {
			base["state"] = "unavailable"
			return base, nil
		}
		return nil, e
	}
	if !s.visible(g, a) {
		return base, nil
	}
	v := event(control)
	base["state"] = "node-authorized-owner"
	if num(v, "expiresAt") <= s.now() {
		base["state"] = "expired"
	}
	for k, value := range (Object{"controlId": control["id"], "nodeId": v["nodeId"], "ownerId": v["ownerId"], "expiresAt": v["expiresAt"], "authority": "Node Galaxy key holder approved this owner and exact declaration through signed Consent; no private key transfer"}) {
		base[k] = value
	}
	return base, nil
}
func (s *Service) workSources(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, payload Object) (Object, error) {
	parent, e := one(ctx, tx, "SELECT id::text,subject_id,state FROM cases WHERE id=$1 FOR SHARE", payload["caseId"])
	if e != nil {
		return nil, e
	}
	if parent == nil || parent["state"] == "withdrawn" {
		return nil, fault.New("builder_work_source_unavailable", 404)
	}
	ids := []string{txt(payload, "caseId"), txt(payload, "attemptId"), txt(payload, "resultId")}
	rows, e := query(ctx, tx, "SELECT id::text,kind,consent_id::text,payload::text AS payload_json,payload_text FROM case_events WHERE case_id=$1 AND id=ANY($2::uuid[]) ORDER BY version", payload["caseId"], ids)
	if e != nil {
		return nil, e
	}
	if len(rows) != 3 {
		return nil, fault.New("builder_work_source_mismatch", 409)
	}
	var root, attempt, result Object
	for _, row := range rows {
		var v Object
		if protocol.Decode([]byte(txt(row, "payload_json")), &v) != nil {
			return nil, fault.New("builder_work_source_mismatch", 409)
		}
		row["payload"] = v
		switch row["id"] {
		case payload["caseId"]:
			root = row
		case payload["attemptId"]:
			attempt = row
		case payload["resultId"]:
			result = row
		}
	}
	if root["kind"] != "case" || attempt["kind"] != "attempt" || result["kind"] != "result" || obj(result["payload"])["attemptId"] != attempt["id"] {
		return nil, fault.New("builder_work_source_mismatch", 409)
	}
	for _, row := range rows {
		g, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: txt(row, "consent_id"), SubjectID: txt(parent, "subject_id"), ObjectID: txt(row, "id"), Action: "case.teaser.publish", Recipient: s.Endpoint, PayloadJSON: txt(row, "payload_text")})
		if e != nil {
			return nil, e
		}
		if !s.visible(g, a) {
			return nil, fault.New("builder_work_source_unavailable", 404)
		}
	}
	proofs := []any{}
	for _, id := range arr(payload["proofIds"]) {
		if s.Proofs == nil {
			return nil, fault.New("builder_proof_service_unavailable", 503)
		}
		proof, e := s.Proofs.ReadWithin(ctx, tx, a, id.(string), false)
		if e != nil {
			return nil, e
		}
		source, e := one(ctx, tx, "SELECT e.id::text,e.case_id::text,e.result_id::text,p.observation_id::text FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id WHERE p.id=$1", id)
		if e != nil {
			return nil, e
		}
		if source == nil || source["case_id"] != payload["caseId"] || source["result_id"] != payload["resultId"] {
			return nil, fault.New("builder_work_source_mismatch", 409)
		}
		item := Object{"proofId": id, "evidenceId": source["id"], "observationId": source["observation_id"], "verification": "ci-execution-fact"}
		if proof["caseContext"] != nil {
			item["caseContext"] = proof["caseContext"]
		}
		if proof["moderationContext"] != nil {
			item["moderationContext"] = proof["moderationContext"]
		}
		proofs = append(proofs, item)
	}
	return Object{"caseId": payload["caseId"], "attemptId": payload["attemptId"], "resultId": payload["resultId"], "reportedOutcome": obj(result["payload"])["outcome"], "outcomeAuthority": "case-owner-reported", "proofs": proofs, "executionAttributionVerified": false}, nil
}
