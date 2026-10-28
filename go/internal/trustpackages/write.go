package trustpackages

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
	"math"
)

func payload(r Object) (Object, error) {
	var p Object
	e := json.Unmarshal([]byte(str(r, "payload_text")), &p)
	return p, e
}
func nullable(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
func (s *Service) Preview(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := Parse("preview", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, control deviceauth.ControlAuthorization) (Object, error) {
		ref := object(q["source"])
		if e := sourceScope(control, ref); e != nil {
			return nil, e
		}
		source, e := s.ownSourceWithin(ctx, tx, a.Actor, ref)
		if e != nil {
			return nil, e
		}
		if source["copyEligible"] != true {
			return nil, fail("trust_linked_source_permission_required")
		}
		p := Object{}
		for k, v := range q {
			p[k] = v
		}
		for k, v := range (Object{"version": 1, "type": "galaxy-trust-source-permission", "kind": "grant", "subjectId": a.SubjectID, "bindingId": a.BindingID, "endpoint": s.Endpoint, "sourceHash": source["sourceHash"], "originalSignatureHash": nil, "purpose": "trust-package-only", "permission": "copy-exact-authored-record", "trainingAllowed": false, "onlineAccessGranted": false, "sourceAuthorDeclaration": "I authorize the exact authored record; no third-party source bodies are included", "keyId": control.KeyID, "epoch": control.Epoch, "chainHead": nullable(control.ChainHead), "issuedAt": s.now()}) {
			p[k] = v
		}
		p, e = ParsePermission(p)
		if e != nil {
			return nil, e
		}
		text, e := canonical(p)
		if e != nil {
			return nil, e
		}
		return Object{"payloadJson": text, "signatureType": "galaxy-trust-source-permission-v1+jws", "sourcePreview": source, "granted": false, "declineEffect": "No signed permission is submitted."}, nil
	})
}
func (s *Service) RevokePreview(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := Parse("revoke-preview", input)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, func(tx pgx.Tx, control deviceauth.ControlAuthorization) (Object, error) {
		r, e := row(ctx, tx, "SELECT to_jsonb(p) FROM trust_package_permissions p WHERE id=$1 AND subject_id=$2", q["id"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if r == nil {
			return nil, fail("trust_permission_unavailable", 404)
		}
		p, e := payload(r)
		if e != nil {
			return nil, e
		}
		for k, v := range (Object{"kind": "revoke", "operationId": q["operationId"], "bindingId": a.BindingID, "keyId": control.KeyID, "epoch": control.Epoch, "chainHead": nullable(control.ChainHead), "issuedAt": s.now(), "expiresAt": s.now() + 300}) {
			p[k] = v
		}
		p, e = ParsePermission(p)
		if e != nil {
			return nil, e
		}
		text, e := canonical(p)
		if e != nil {
			return nil, e
		}
		return Object{"payloadJson": text, "signatureType": "galaxy-trust-source-permission-v1+jws", "permissionId": q["id"], "externalCopiesDeleted": false, "revoked": r["revoked_at"] != nil}, nil
	})
}
func (s *Service) Submit(ctx context.Context, a Actor, input Object) (Object, error) {
	q, e := Parse("submit", input)
	if e != nil {
		return nil, e
	}
	if s.VerifyPermission == nil {
		return nil, fail("trust_signature_adapter_unavailable", 503)
	}
	return s.run(ctx, a, true, func(tx pgx.Tx, control deviceauth.ControlAuthorization) (Object, error) {
		text, e := s.VerifyPermission(str(q, "signed"), control.PublicKey)
		if e != nil {
			return nil, fail("invalid_trust_signature", 400)
		}
		var p Object
		if json.Unmarshal([]byte(text), &p) != nil {
			return nil, fail("invalid_trust_signature", 400)
		}
		p, e = ParsePermission(p)
		if e != nil {
			return nil, fail("invalid_trust_signature", 400)
		}
		if p["subjectId"] != a.SubjectID || p["bindingId"] != a.BindingID || p["endpoint"] != s.Endpoint || p["keyId"] != control.KeyID || number(p["epoch"]) != control.Epoch || !same(p["chainHead"], nullable(control.ChainHead)) {
			return nil, fail("trust_signer_context_changed", 403)
		}
		if e = s.localSource(object(p["source"])); e != nil {
			return nil, e
		}
		hash := identity.Digest([]byte(str(q, "signed")))
		existing, e := row(ctx, tx, "SELECT to_jsonb(p) FROM trust_package_permissions p WHERE id=$1 FOR UPDATE", p["id"])
		if e != nil {
			return nil, e
		}
		if p["kind"] == "grant" && existing != nil {
			if existing["subject_id"] != a.SubjectID || existing["signature_hash"] != hash {
				return nil, fail("trust_permission_conflict")
			}
			return s.receiptRow(existing), nil
		}
		if p["kind"] == "revoke" && existing != nil && existing["revoke_operation_id"] == p["operationId"] {
			if existing["subject_id"] != a.SubjectID || existing["revoke_signature_hash"] != hash {
				return nil, fail("trust_permission_conflict")
			}
			return s.receiptRow(existing), nil
		}
		if math.Abs(float64(number(p["issuedAt"])-s.now())) > 300 || number(p["expiresAt"]) <= s.now() {
			return nil, fail("trust_permission_time_changed")
		}
		if p["kind"] == "grant" {
			if e = sourceScope(control, object(p["source"])); e != nil {
				return nil, e
			}
			if p["originalSignatureHash"] != nil {
				return nil, fail("trust_original_signature_copy_not_authorized")
			}
			source, e := s.ownSourceWithin(ctx, tx, a.Actor, object(p["source"]))
			if e != nil {
				return nil, e
			}
			if source["copyEligible"] != true {
				return nil, fail("trust_linked_source_permission_required")
			}
			if source["sourceHash"] != p["sourceHash"] {
				return nil, fail("trust_source_changed")
			}
			publicIdentity, e := s.Devices.TrustIdentityWithin(ctx, tx, a.SubjectID)
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "INSERT INTO trust_package_permissions(id,subject_id,grantee_id,operation_id,payload_text,signed,signature_hash,identity,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING", p["id"], a.SubjectID, p["grantee"], p["operationId"], text, q["signed"], hash, publicIdentity, iso(number(p["issuedAt"])), iso(number(p["expiresAt"]))); e != nil {
				return nil, e
			}
			saved, e := row(ctx, tx, "SELECT to_jsonb(p) FROM trust_package_permissions p WHERE id=$1 FOR UPDATE", p["id"])
			if e != nil {
				return nil, e
			}
			if saved == nil || saved["signature_hash"] != hash {
				return nil, fail("trust_permission_conflict")
			}
			if e = s.auditWithin(ctx, tx, a, control, p); e != nil {
				return nil, e
			}
			return s.receiptRow(saved), nil
		}
		if existing == nil || existing["subject_id"] != a.SubjectID {
			return nil, fail("trust_permission_unavailable", 404)
		}
		old, e := payload(existing)
		if e != nil {
			return nil, e
		}
		for _, key := range []string{"source", "sourceHash", "grantee", "audience", "originalSignatureHash"} {
			if !same(p[key], old[key]) {
				return nil, fail("trust_revoke_scope_changed")
			}
		}
		if existing["revoked_at"] != nil {
			return nil, fail("trust_permission_already_revoked")
		}
		if _, e = tx.Exec(ctx, "UPDATE trust_package_permissions SET revoked_at=$2,revoke_operation_id=$3,revoke_payload_text=$4,revoke_signed=$5,revoke_signature_hash=$6 WHERE id=$1", p["id"], iso(s.now()), p["operationId"], text, q["signed"], hash); e != nil {
			return nil, e
		}
		if e = s.auditWithin(ctx, tx, a, control, p); e != nil {
			return nil, e
		}
		saved, e := row(ctx, tx, "SELECT to_jsonb(p) FROM trust_package_permissions p WHERE id=$1", p["id"])
		if e != nil {
			return nil, e
		}
		return s.receiptRow(saved), nil
	})
}
func (s *Service) auditWithin(ctx context.Context, tx pgx.Tx, a Actor, control deviceauth.ControlAuthorization, p Object) error {
	_, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'consent',b.id,$5,$4,b.scopes,$6::jsonb,b.id,ch.payload->>'installationId',b.audience,b.scopes FROM bindings b JOIN binding_challenges ch ON ch.id=b.challenge_id WHERE b.id=$7 AND b.subject_id=$1`, a.SubjectID, "trust.permission."+str(p, "kind"), p["id"], p["operationId"], a.HTTPRequestID, control.CredentialScopes, a.BindingID)
	return e
}
