package identitygroups

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

func (s *Service) required(g, p Object) ([]any, error) {
	if p["kind"] == "create" {
		if num(g, "version") != 0 || g["state"] != "proposed" {
			return nil, fault.New("identity_group_version_changed", 409)
		}
		return arr(p["memberIds"]), nil
	}
	if num(g, "version") != num(p, "expectedVersion") || g["current_operation_id"] != p["previousOperationId"] {
		return nil, fault.New("identity_group_version_changed", 409)
	}
	if g["state"] != "active" || p["kind"] != "revoke" && g["source_erased_at"] != nil {
		return nil, fault.New("identity_group_inactive", 409)
	}
	ids := append([]any{}, arr(g["member_ids"])...)
	if p["kind"] != "revoke" {
		for _, id := range arr(p["memberIds"]) {
			if !has(ids, id) {
				ids = append(ids, id)
			}
		}
	}
	return ids, nil
}
func (s *Service) state(ctx context.Context, tx pgx.Tx, op Object, a *deviceauth.Actor) (Object, error) {
	approvals, e := query(ctx, tx, "SELECT * FROM identity_group_approvals_v2 WHERE operation_id=$1 ORDER BY sequence", op["id"])
	if e != nil {
		return nil, e
	}
	latest := []Object{}
	positions := map[string]int{}
	ack := []any{}
	for _, approval := range approvals {
		subject := txt(approval, "subject_id")
		if i, ok := positions[subject]; ok {
			latest[i] = approval
		} else {
			positions[subject] = len(latest)
			latest = append(latest, approval)
		}
		if a != nil && a.SubjectID == subject {
			ack = append(ack, approval["id"])
		}
	}
	current := op["state"]
	if current == "pending" && seconds(op["expires_at"]) <= s.now() {
		current = "expired"
	}
	items := []any{}
	for _, approval := range latest {
		var proof Object
		if protocol.Decode([]byte(txt(approval, "proof_text")), &proof) != nil {
			return nil, fault.New("identity_group_approval_invalid", 500)
		}
		items = append(items, Object{"id": approval["id"], "subjectId": approval["subject_id"], "decision": approval["decision"], "keyId": approval["key_id"], "epoch": approval["epoch"], "at": stamp(approval["created_at"]), "expiresAt": proof["expiresAt"]})
	}
	return Object{"operationId": op["id"], "groupId": op["group_id"], "payloadHash": op["payload_hash"], "state": current, "resultVersion": op["result_version"], "requiredSubjectIds": op["required_ids"], "approvals": items, "acknowledgedProofIds": ack, "expiresAt": stamp(op["expires_at"]), "acceptedOperationOnly": true, "currentAccessGranted": false}, nil
}
func (s *Service) receiptWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, in Object) (Object, error) {
	op, e := one(ctx, tx, "SELECT * FROM identity_group_operations_v2 WHERE id=$1", in["operationId"])
	if e != nil {
		return nil, e
	}
	if op == nil {
		return Object{"operationId": in["operationId"], "state": "absent"}, nil
	}
	if op["subject_id"] != a.SubjectID && !has(arr(op["required_ids"]), a.SubjectID) {
		return nil, fault.New("identity_group_unavailable", 404)
	}
	if op["payload_hash"] != in["payloadHash"] {
		return Object{"operationId": in["operationId"], "state": "conflict", "payloadHashMismatch": true}, nil
	}
	return s.state(ctx, tx, op, &a)
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	in, e := parse("identityGroupReceiptSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.receiptWithin(ctx, tx, a, in)
	})
}
func (s *Service) Submit(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	in, e := parse("identityGroupSubmitSchema", raw)
	if e != nil {
		return nil, e
	}
	p, e := ParseIntent([]byte(txt(in, "payloadJson")))
	if e != nil {
		return nil, e
	}
	proof, e := ParseProof([]byte(txt(in, "proofJson")))
	if e != nil {
		return nil, e
	}
	if p["endpoint"] != s.Endpoint || proof["endpoint"] != p["endpoint"] || proof["operationId"] != p["operationId"] || proof["groupId"] != p["groupId"] || proof["payloadHash"] != identity.Digest([]byte(txt(in, "payloadJson"))) || proof["subjectId"] != a.SubjectID {
		return nil, fault.New("identity_group_signature_scope", 403)
	}
	if p["kind"] == "create" && (num(p, "expectedVersion") != 0 || p["previousOperationId"] != nil) || p["kind"] != "create" && (num(p, "expectedVersion") <= 0 || p["previousOperationId"] == nil) {
		return nil, fault.New("invalid_identity_group", 400)
	}
	return s.run(ctx, &a, true, p["kind"] == "revoke" || proof["decision"] != "approve", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		c, e := s.control(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		if c.KeyID != proof["keyId"] || c.Epoch != num(proof, "epoch") {
			return nil, fault.New("identity_group_control_changed", 401)
		}
		if deviceauth.VerifyIdentityGroupSignature(txt(in, "signature"), txt(in, "proofJson"), c.PublicKey) != nil {
			return nil, fault.New("identity_control_proof_invalid", 401)
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "identity-group:"+txt(p, "groupId")); e != nil {
			return nil, e
		}
		op, e := one(ctx, tx, "SELECT * FROM identity_group_operations_v2 WHERE id=$1 FOR UPDATE", p["operationId"])
		if e != nil {
			return nil, e
		}
		prior, e := one(ctx, tx, "SELECT * FROM identity_group_approvals_v2 WHERE id=$1", proof["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["operation_id"] != p["operationId"] || prior["subject_id"] != a.SubjectID || prior["proof_text"] != in["proofJson"] || prior["signature"] != in["signature"] || op["payload_text"] != in["payloadJson"] {
				return nil, fault.New("identity_group_operation_conflict", 409)
			}
			return s.state(ctx, tx, op, &a)
		}
		if num(p, "issuedAt") > s.now()+2 || num(p, "expiresAt") <= s.now() || num(proof, "issuedAt") > s.now()+2 || num(proof, "expiresAt") <= s.now() || num(proof, "expiresAt") > num(p, "expiresAt") || num(proof, "expiresAt") <= num(proof, "issuedAt") {
			return nil, fault.New("identity_group_proposal_expired", 409)
		}
		g, e := one(ctx, tx, "SELECT * FROM identity_groups_v2 WHERE id=$1 FOR UPDATE", p["groupId"])
		if e != nil {
			return nil, e
		}
		if g == nil {
			if p["kind"] != "create" || !has(arr(p["memberIds"]), a.SubjectID) || proof["decision"] != "approve" {
				return nil, fault.New("identity_group_unavailable", 404)
			}
			members, _ := protocol.Encode([]any{a.SubjectID})
			if _, e = tx.Exec(ctx, "INSERT INTO identity_groups_v2(id,subject_id,member_ids,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$4)", p["groupId"], a.SubjectID, string(members), time.Unix(s.now(), 0)); e != nil {
				return nil, e
			}
			g, e = one(ctx, tx, "SELECT * FROM identity_groups_v2 WHERE id=$1", p["groupId"])
			if e != nil {
				return nil, e
			}
		}
		if op == nil {
			if p["kind"] == "create" && g["subject_id"] != a.SubjectID {
				return nil, fault.New("identity_group_not_proposer", 403)
			}
			required, e := s.required(g, p)
			if e != nil {
				return nil, e
			}
			if !has(required, a.SubjectID) {
				return nil, fault.New("identity_group_not_member", 403)
			}
			if proof["decision"] != "approve" {
				return nil, fault.New("identity_group_proposal_required", 409)
			}
			if p["kind"] == "revoke" && !has(arr(g["member_ids"]), a.SubjectID) {
				return nil, fault.New("identity_group_not_member", 403)
			}
			count, e := one(ctx, tx, "SELECT count(*)::int n FROM identity_group_operations_v2 WHERE subject_id=$1 AND state='pending' AND expires_at>$2", a.SubjectID, time.Unix(s.now(), 0))
			if e != nil {
				return nil, e
			}
			if p["kind"] != "revoke" && num(count, "n") >= 20 {
				return nil, fault.New("identity_group_pending_limit", 429)
			}
			ids, _ := protocol.Encode(required)
			if _, e = tx.Exec(ctx, "INSERT INTO identity_group_operations_v2(id,group_id,subject_id,kind,expected_version,required_ids,payload_text,payload_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)", p["operationId"], p["groupId"], a.SubjectID, p["kind"], p["expectedVersion"], string(ids), in["payloadJson"], identity.Digest([]byte(txt(in, "payloadJson"))), time.Unix(s.now(), 0), time.Unix(num(p, "expiresAt"), 0)); e != nil {
				return nil, e
			}
			op, e = one(ctx, tx, "SELECT * FROM identity_group_operations_v2 WHERE id=$1", p["operationId"])
			if e != nil {
				return nil, e
			}
		}
		if op["payload_text"] != in["payloadJson"] || op["group_id"] != p["groupId"] {
			return nil, fault.New("identity_group_operation_conflict", 409)
		}
		if !has(arr(op["required_ids"]), a.SubjectID) {
			return nil, fault.New("identity_group_not_member", 403)
		}
		if op["state"] != "pending" {
			return nil, fault.New("identity_group_operation_closed", 409)
		}
		if proof["decision"] == "cancel" && op["subject_id"] != a.SubjectID {
			return nil, fault.New("identity_group_not_proposer", 403)
		}
		pending, e := s.deletionPending(ctx, tx, []string{a.SubjectID})
		if e != nil {
			return nil, e
		}
		if p["kind"] != "revoke" && proof["decision"] == "approve" && pending {
			return nil, fault.New("identity_group_deletion_pending", 409)
		}
		if proof["decision"] == "approve" && p["kind"] != "revoke" {
			for _, raw := range arr(p["sourceRefs"]) {
				ref := obj(raw)
				if ref["originalSubjectId"] == a.SubjectID {
					if _, e = s.SourceWithin(ctx, tx, &a, ref, false); e != nil {
						return nil, e
					}
				}
			}
		}
		if _, e = tx.Exec(ctx, "INSERT INTO identity_group_approvals_v2(id,operation_id,subject_id,decision,proof_text,signature,key_id,epoch,public_key,chain_head,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", proof["id"], p["operationId"], a.SubjectID, proof["decision"], in["proofJson"], in["signature"], c.KeyID, c.Epoch, c.PublicKey, c.ChainHead, time.Unix(s.now(), 0)); e != nil {
			return nil, e
		}
		end := ""
		if proof["decision"] == "decline" {
			end = "declined"
		}
		if proof["decision"] == "cancel" {
			end = "cancelled"
		}
		if end == "" {
			state, e := s.state(ctx, tx, op, nil)
			if e != nil {
				return nil, e
			}
			latest := arr(state["approvals"])
			complete := true
			for _, id := range arr(op["required_ids"]) {
				found := false
				for _, raw := range latest {
					approval := obj(raw)
					found = found || approval["subjectId"] == id && approval["decision"] == "approve"
				}
				complete = complete && found
			}
			if p["kind"] == "revoke" || complete {
				if num(g, "version") != num(p, "expectedVersion") || g["current_operation_id"] != p["previousOperationId"] {
					end = "conflict"
				} else {
					ids := []string{}
					if p["kind"] == "revoke" {
						ids = append(ids, a.SubjectID)
					} else {
						for _, id := range arr(op["required_ids"]) {
							ids = append(ids, id.(string))
						}
					}
					pending, e := s.deletionPending(ctx, tx, ids)
					if e != nil {
						return nil, e
					}
					if p["kind"] != "revoke" && pending {
						return nil, fault.New("identity_group_deletion_pending", 409)
					}
					sort.Strings(ids)
					for _, id := range ids {
						var approval Object
						for _, raw := range latest {
							if obj(raw)["subjectId"] == id {
								approval = obj(raw)
								break
							}
						}
						if num(approval, "expiresAt") <= s.now() {
							return nil, fault.New("identity_group_approval_expired", 409)
						}
						key := txt(approval, "keyId")
						if _, e = s.Devices.CurrentSignerWithin(ctx, tx, id, nil, &key, num(approval, "epoch"), "manage-identity"); e != nil {
							return nil, e
						}
					}
					if e = s.approvedSources(ctx, tx, p); e != nil {
						return nil, e
					}
					members := p["memberIds"]
					state := "active"
					if p["kind"] == "revoke" {
						members = g["member_ids"]
						state = "revoked"
					}
					memberJSON, _ := protocol.Encode(members)
					if _, e = tx.Exec(ctx, "UPDATE identity_groups_v2 SET version=version+1,state=$2,current_operation_id=$3,member_ids=$4::jsonb,updated_at=$5 WHERE id=$1", p["groupId"], state, p["operationId"], string(memberJSON), time.Unix(s.now(), 0)); e != nil {
						return nil, e
					}
					end = "committed"
				}
			}
		}
		if end != "" {
			var version any
			if end == "committed" {
				version = num(g, "version") + 1
			}
			if _, e = tx.Exec(ctx, "UPDATE identity_group_operations_v2 SET state=$2,closed_at=$3,result_version=$4 WHERE id=$1", p["operationId"], end, time.Unix(s.now(), 0), version); e != nil {
				return nil, e
			}
		}
		var rid any
		if requestID != "" {
			rid = requestID
		}
		scopes, _ := protocol.Encode(auth.CredentialScopes)
		if _, e = tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'binding',b.id,$5,$4,b.scopes,$6::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$7 AND b.subject_id=$1`, a.SubjectID, "identity.group.approval", p["groupId"], proof["id"], rid, string(scopes), a.BindingID); e != nil {
			return nil, e
		}
		op, e = one(ctx, tx, "SELECT * FROM identity_group_operations_v2 WHERE id=$1", p["operationId"])
		if e != nil {
			return nil, e
		}
		return s.state(ctx, tx, op, &a)
	})
}
