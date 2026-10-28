package experiencereviews

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

type Envelope struct {
	ConsentID   string `json:"consentId"`
	PayloadJSON string `json:"payloadJson"`
}

func lowerJS(value any) any {
	units, _ := units(value)
	out := jstext.String{}
	start := 0
	lower := cases.Lower(language.Und)
	for i := 0; i < len(units); i++ {
		v := units[i]
		if v >= 0xd800 && v <= 0xdbff && i+1 < len(units) && units[i+1] >= 0xdc00 && units[i+1] <= 0xdfff {
			i++
			continue
		}
		if v >= 0xd800 && v <= 0xdfff {
			out = append(out, jstext.From(lower.String(units[start:i].Decoded()))...)
			out = append(out, v)
			start = i + 1
		}
	}
	out = append(out, jstext.From(lower.String(units[start:].Decoded()))...)
	if out.HasUnpaired() {
		return out
	}
	return out.Decoded()
}
func sourceKey(p Object) (string, error) {
	source := object(p["source"])
	raw, e := protocol.EncodeJS([]any{lowerJS(source["system"]), source["stableRecord"]})
	if e != nil {
		return "", e
	}
	return identity.Digest(raw), nil
}
func (s *Service) Submit(ctx context.Context, a Actor, input Envelope) (any, error) {
	p, e := ParseEvent([]byte(input.PayloadJSON))
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, p["kind"] == "revoke", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		if p["reportedBy"] != a.SubjectID {
			return nil, fail("experience_reporter_mismatch", 403)
		}
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: input.ConsentID, SubjectID: a.SubjectID, ObjectID: str(p, "operationId"), Action: "experience.submit", Recipient: s.Endpoint, PayloadJSON: input.PayloadJSON})
		if e != nil {
			return nil, e
		}
		if grant.Visibility != "Private" && grant.Visibility != "Public" {
			return nil, fail("experience_visibility_required", 403)
		}
		previous, e := row(ctx, tx, "SELECT to_jsonb(e)||jsonb_build_object('subject_id',o.subject_id) FROM experience_events e JOIN experience_objects o ON o.id=e.object_id WHERE operation_id=$1", p["operationId"])
		if e != nil {
			return nil, e
		}
		hash := identity.Digest([]byte(input.PayloadJSON))
		if previous != nil {
			if previous["subject_id"] != a.SubjectID || previous["object_id"] != p["id"] || previous["payload_hash"] != hash || previous["consent_id"] != input.ConsentID {
				return nil, fail("experience_operation_conflict")
			}
			return Object{"id": p["id"], "version": previous["version"], "operationId": p["operationId"], "acknowledged": true}, nil
		}
		kind := str(p, "kind")
		objectType := "experience"
		if kind == "review" {
			objectType = "review"
		}
		var source, reviewer Object
		if kind == "review" {
			ref := object(p["experienceRef"])
			source, e = s.ReadWithin(ctx, tx, &a.Actor, str(ref, "id"), number(ref["version"]))
			if e != nil {
				return nil, e
			}
			sourceRecord := object(source["record"])
			if source["type"] != "experience" || source["referenceStatus"] != "current" || sourceRecord == nil {
				return nil, fail("experience_source_unavailable")
			}
			reviewer, e = s.reviewerWithin(ctx, tx, a.SubjectID, str(p, "capabilityId"), str(sourceRecord, "kind"))
			if e != nil {
				return nil, e
			}
			if p["capabilityId"] != sourceRecord["capabilityId"] {
				return nil, fail("experience_capability_mismatch")
			}
			if e = s.independent(ctx, tx, a.SubjectID, str(sourceRecord, "subjectId")); e != nil {
				return nil, e
			}
			if p["synthetic"] != true && (source["synthetic"] == true || reviewer["synthetic"] == true) {
				return nil, fail("synthetic_mismatch", 422)
			}
			if p["state"] == "verified-in-scope" {
				for _, v := range object(p["checked"]) {
					if v != true {
						return nil, fail("experience_review_checks_incomplete")
					}
				}
			}
			observed, _ := date(p["observedAt"])
			if observed.UnixMilli() > s.now()*1000+300000 {
				return nil, fail("experience_observation_in_future")
			}
		} else if kind != "revoke" {
			if p["subjectId"] != a.SubjectID {
				return nil, fail("experience_owner_required", 403)
			}
			original, _ := date(object(p["source"])["originalAt"])
			if original.UnixMilli() > s.now()*1000+300000 {
				return nil, fail("experience_source_in_future")
			}
		}
		if number(p["expectedVersion"]) == 0 && kind != "revoke" {
			var key, experienceID any
			if objectType == "experience" {
				key, e = sourceKey(p)
				if e != nil {
					return nil, e
				}
			} else {
				experienceID = object(p["experienceRef"])["id"]
			}
			if _, e = tx.Exec(ctx, "INSERT INTO experience_objects(id,object_type,subject_id,source_key,experience_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING", p["id"], objectType, a.SubjectID, key, experienceID); e != nil {
				var pg *pgconn.PgError
				if errors.As(e, &pg) && pg.Code == "23505" {
					return nil, fail("experience_stable_source_already_registered")
				}
				return nil, e
			}
		}
		current, e := row(ctx, tx, "SELECT to_jsonb(o) FROM experience_objects o WHERE id=$1 FOR UPDATE", p["id"])
		if e != nil {
			return nil, e
		}
		if current == nil || current["subject_id"] != a.SubjectID {
			return nil, fail("experience_owner_required", 403)
		}
		if kind == "revoke" {
			objectType = str(p, "objectType")
		}
		if current["object_type"] != objectType {
			return nil, fail("experience_type_mismatch")
		}
		if current["state"] != "active" {
			return nil, fail("experience_revoked")
		}
		if number(current["version"]) != number(p["expectedVersion"]) || number(current["version"]) >= 100 {
			return nil, fail("experience_version_conflict")
		}
		if kind != "revoke" && number(p["expectedVersion"]) > 0 {
			if p["reason"] == nil {
				return nil, fail("experience_correction_reason_required")
			}
			if objectType == "experience" {
				key, e := sourceKey(p)
				if e != nil {
					return nil, e
				}
				if current["source_key"] != key {
					return nil, fail("experience_stable_source_mismatch")
				}
			} else if current["experience_id"] != object(p["experienceRef"])["id"] {
				return nil, fail("experience_source_mismatch")
			}
			old, e := row(ctx, tx, "SELECT to_jsonb(e) FROM experience_events e WHERE object_id=$1 AND version=$2", p["id"], current["version"])
			if e != nil {
				return nil, e
			}
			if old == nil || str(old, "payload_text") == "" {
				return nil, fail("experience_unavailable", 404)
			}
			decoded, e := decodeValue([]byte(str(old, "payload_text")))
			if e != nil {
				return nil, e
			}
			if p["synthetic"] != true && object(decoded)["synthetic"] == true {
				return nil, fail("synthetic_mismatch")
			}
		}
		context := Object{"recordedAt": time.Unix(s.now(), 0).UTC().Format("2006-01-02T15:04:05.000Z"), "reviewerAuthority": reviewer["authorityReference"], "reviewerScope": reviewer["scope"], "externalExecutionIndependentlyVerified": false}
		raw, e := json.Marshal(context)
		if e != nil {
			return nil, e
		}
		version := number(current["version"]) + 1
		if _, e = tx.Exec(ctx, "INSERT INTO experience_events(operation_id,object_id,version,consent_id,payload_text,payload_hash,context) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)", p["operationId"], p["id"], version, input.ConsentID, input.PayloadJSON, hash, raw); e != nil {
			return nil, e
		}
		state := "active"
		if kind == "revoke" {
			state = "revoked"
		}
		if _, e = tx.Exec(ctx, "UPDATE experience_objects SET version=$2,state=$3 WHERE id=$1", p["id"], version, state); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, p, input.ConsentID); e != nil {
			return nil, e
		}
		reported := "declared"
		if kind == "revoke" {
			reported = "revoked"
		} else if kind == "review" {
			reported = str(p, "state")
		}
		return Object{"id": p["id"], "operationId": p["operationId"], "version": version, "state": reported, "capabilityVerified": false}, nil
	})
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, p Object, consentID string) error {
	scopes, _ := json.Marshal(auth.CredentialScopes)
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
SELECT $1,$2,$3,$4,'accepted',1,ch.payload->>'installationId',b.audience,'assistance',c.id,b.id,$5,$4,b.scopes,$6::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$7::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$8 AND c.subject_id=$1`, a.SubjectID, "experience."+str(p, "kind"), p["id"], p["operationId"], a.HTTPRequestID, scopes, a.BindingID, consentID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fail("experience_audit_unavailable", 503)
	}
	return nil
}
