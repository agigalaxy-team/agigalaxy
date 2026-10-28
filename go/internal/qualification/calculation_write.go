package qualification

import (
	"context"
	"encoding/json"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
)

type Envelope struct {
	ConsentID   string `json:"consentId"`
	PayloadJSON string `json:"payloadJson"`
}

func (s *Service) resourceWrite(ctx context.Context, a Actor, control bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (any, error)) (any, error) {
	if e := deviceauth.CheckInformationWatchWrite(a.Actor, "assistance"); e != nil {
		return nil, e
	}
	if s == nil || s.Pool == nil || s.Devices == nil || s.Endpoint != s.Devices.Endpoint {
		return nil, fail("qualification_unavailable", 503)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (any, error) {
		var auth deviceauth.ControlAuthorization
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			var e error
			auth, e = s.Devices.CurrentControlWithin(ctx, tx, a.Actor, "assistance")
			return e
		}
		budget := s.Resources
		if budget == nil {
			budget, _ = resourcebudget.New(nil, s.Now)
		}
		return budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.SubjectID}, authorize, func(context.Context, pgx.Tx) (any, error) { return fn(tx, auth) }, resourcebudget.Options{Control: control})
	})
}
func (s *Service) SubmitCalculation(ctx context.Context, a Actor, input Envelope) (any, error) {
	p, e := ParseCalculation([]byte(input.PayloadJSON))
	if e != nil {
		return nil, e
	}
	return s.resourceWrite(ctx, a, p["kind"] == "revoke", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		var target Object
		kind := str(p, "kind")
		if kind == "revoke" {
			var e error
			target, e = readRow(ctx, tx, "SELECT to_jsonb(g) FROM qualification_calculation_grants g WHERE id=$1 AND subject_id=$2 FOR UPDATE", p["grantId"], a.SubjectID)
			if e != nil {
				return nil, e
			}
			if target == nil || str(target, "payload_text") == "" {
				return nil, fail("qualification_calculation_unavailable", 403)
			}
			var original Object
			if e = json.Unmarshal([]byte(str(target, "payload_text")), &original); e != nil {
				return nil, e
			}
			kind = str(original, "kind")
		}
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: input.ConsentID, SubjectID: a.SubjectID, ObjectID: str(p, "id"), Action: calculationAction(kind), Recipient: s.Endpoint, PayloadJSON: input.PayloadJSON})
		if e != nil {
			return nil, e
		}
		hash := identity.Digest([]byte(input.PayloadJSON))
		if p["kind"] == "revoke" {
			if target["revoked_at"] != nil {
				if target["revoke_id"] != p["id"] || target["revoke_consent_id"] != input.ConsentID || target["revoke_payload_hash"] != hash {
					return nil, fail("qualification_calculation_conflict")
				}
			} else {
				if _, e = tx.Exec(ctx, "UPDATE qualification_calculation_grants SET revoked_at=$2,revoke_id=$3,revoke_consent_id=$4,revoke_payload_text=$5,revoke_payload_hash=$6 WHERE id=$1", p["grantId"], time.Unix(s.now(), 0), p["id"], input.ConsentID, input.PayloadJSON, hash); e != nil {
					return nil, e
				}
			}
		} else {
			expires, _ := parseDatetime(p["expiresAt"])
			if expires.UnixMilli() <= s.now()*1000 {
				return nil, fail("qualification_calculation_expired", 403)
			}
			var requester string
			if e = tx.QueryRow(ctx, "SELECT requester_id FROM task_requests WHERE id=$1", p["taskId"]).Scan(&requester); e != nil && e != pgx.ErrNoRows {
				return nil, e
			}
			if e == pgx.ErrNoRows || requester != p["recipientId"] {
				return nil, fail("qualification_calculation_recipient_mismatch", 403)
			}
			if s.Assistance == nil {
				return nil, fail("qualification_assistance_unavailable", 503)
			}
			if grant.Visibility != "Private" || !s.Assistance.LegacySourceVisible(grant, str(p, "candidateId")) || !s.Assistance.LegacySourceVisible(grant, str(p, "recipientId")) {
				return nil, fail("qualification_calculation_visibility_required", 403)
			}
			for _, viewer := range grant.Viewers {
				if viewer != p["candidateId"] && viewer != p["recipientId"] {
					return nil, fail("qualification_calculation_visibility_required", 403)
				}
			}
			var covered map[string]string
			if p["kind"] == "compute" {
				if p["candidateId"] != a.SubjectID {
					return nil, fail("qualification_candidate_required", 403)
				}
				evidence := object(p["evidence"])
				supported := true
				for _, key := range []string{"capsuleUseIds", "proofIds", "assistanceIds"} {
					if len(array(evidence[key])) != 0 {
						supported = false
					}
				}
				if len(array(evidence["externalReviewRefs"])) > 0 {
					experience := false
					for _, v := range array(p["sourceRefs"]) {
						if object(v)["kind"] == "experience-event" {
							experience = true
						}
					}
					supported = supported && experience
				}
				if !supported {
					return nil, fail("qualification_calculation_source_kind_unsupported", 422)
				}
				if _, e = s.Assistance.RequireTaskWithin(ctx, tx, &a.Actor, str(p, "taskId"), false); e != nil {
					return nil, e
				}
				covered, e = s.calculationPermissions(ctx, tx, a.Actor, p)
				if e != nil {
					return nil, e
				}
			}
			for _, v := range array(p["sourceRefs"]) {
				ref := object(v)
				row, e := s.calculationSourceWithin(ctx, tx, ref)
				if e != nil {
					return nil, e
				}
				g, e := s.calculationSourceGrant(ctx, tx, ref, row)
				if e != nil {
					return nil, e
				}
				if p["kind"] == "source-permission" {
					if row["subject_id"] != a.SubjectID {
						return nil, fail("qualification_source_author_required", 403)
					}
				} else {
					if !s.Assistance.LegacySourceVisible(g, a.SubjectID) {
						return nil, fail("qualification_candidate_source_unavailable", 403)
					}
					if row["subject_id"] != a.SubjectID && covered[sourceKey(ref)] != row["subject_id"] {
						return nil, fail("qualification_source_permission_required", 403)
					}
				}
			}
			prior, e := readRow(ctx, tx, "SELECT to_jsonb(g) FROM qualification_calculation_grants g WHERE id=$1", p["id"])
			if e != nil {
				return nil, e
			}
			if prior != nil {
				if prior["subject_id"] != a.SubjectID || prior["payload_hash"] != hash || prior["consent_id"] != input.ConsentID {
					return nil, fail("qualification_calculation_conflict")
				}
			} else {
				if _, e = tx.Exec(ctx, "INSERT INTO qualification_calculation_grants(id,subject_id,task_id,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6)", p["id"], a.SubjectID, p["taskId"], input.ConsentID, input.PayloadJSON, hash); e != nil {
					return nil, e
				}
			}
		}
		action := calculationAction(kind) + ".grant"
		id := p["id"]
		state := "recorded"
		if p["kind"] == "revoke" {
			action = calculationAction(kind) + ".revoke"
			id = p["grantId"]
			state = "revoked"
		}
		scopes, _ := json.Marshal(auth.CredentialScopes)
		_, e = tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
SELECT $1,$2,$3,$3,'accepted',1,ch.payload->>'installationId',b.audience,'assistance',c.id,b.id,$4,$3,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
WHERE c.id=$7 AND c.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$2 AND request_id=$3)`, a.SubjectID, action, p["id"], a.HTTPRequestID, scopes, a.BindingID, input.ConsentID)
		if e != nil {
			return nil, e
		}
		return Object{"grantId": id, "state": state, "sourceReadGranted": false, "publicHistoryGranted": false}, nil
	})
}
func (s *Service) CalculationReceipt(ctx context.Context, a Actor, input Object) (any, error) {
	if !queryClosed(input, []string{"operationId", "payloadHash"}, nil) || !uuidPattern.MatchString(str(input, "operationId")) || !sha256Pattern.MatchString(str(input, "payloadHash")) {
		return nil, fail("invalid_qualification_receipt", 400)
	}
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) {
		r, e := readRow(ctx, tx, `SELECT to_jsonb(x) FROM (SELECT id,payload_hash,consent_id FROM qualification_calculation_grants WHERE id=$1 AND subject_id=$2 UNION ALL SELECT id,revoke_payload_hash payload_hash,revoke_consent_id consent_id FROM qualification_calculation_grants WHERE revoke_id=$1 AND subject_id=$2)x`, input["operationId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		state := "absent"
		if r != nil {
			state = "conflict"
			if r["payload_hash"] == input["payloadHash"] {
				state = "acknowledged"
			}
		}
		out := Object{"operationId": input["operationId"], "state": state, "currentReadPermissionConfirmed": false}
		if state == "acknowledged" {
			out["grantId"], out["consentId"] = r["id"], r["consent_id"]
		}
		return out, nil
	})
}
