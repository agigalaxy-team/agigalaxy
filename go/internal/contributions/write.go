package contributions

import (
	"context"
	"encoding/json"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

type Envelope struct {
	ConsentID   string `json:"consentId"`
	PayloadJSON string `json:"payloadJson"`
}

func (s *Service) Submit(ctx context.Context, a Actor, input Envelope) (any, error) {
	p, e := ParsePublication([]byte(input.PayloadJSON))
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, true, p["kind"] == "revoke", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: input.ConsentID, SubjectID: a.SubjectID, ObjectID: str(p, "id"), Action: "contribution.publish", Recipient: s.Endpoint, PayloadJSON: input.PayloadJSON})
		if e != nil {
			return nil, e
		}
		hash := identity.Digest([]byte(input.PayloadJSON))
		if p["kind"] == "publish" {
			expiry, _ := date(p["expiresAt"])
			if grant.Visibility != "Public" || grant.Purpose != "public-profile" || expiry.UnixMilli() <= s.now()*1000 {
				return nil, fail("contribution_publication_scope_required")
			}
			for _, v := range array(p["sourceRefs"]) {
				ref := object(v)
				source, e := s.SourceWithin(ctx, tx, ref)
				if e != nil {
					return nil, e
				}
				if _, e = s.SourceGrantWithin(ctx, tx, str(ref, "kind"), source); e != nil {
					return nil, e
				}
				if source["subject_id"] != a.SubjectID {
					return nil, fail("contribution_source_author_required")
				}
			}
			prior, e := row(ctx, tx, "SELECT to_jsonb(p) FROM contribution_publications p WHERE id=$1", p["id"])
			if e != nil {
				return nil, e
			}
			if prior != nil {
				if prior["subject_id"] != a.SubjectID || prior["payload_hash"] != hash || prior["consent_id"] != input.ConsentID {
					return nil, fail("contribution_publication_conflict", 409)
				}
			} else {
				refs, e := json.Marshal(p["sourceRefs"])
				if e != nil {
					return nil, e
				}
				if _, e = tx.Exec(ctx, "INSERT INTO contribution_publications(id,subject_id,consent_id,source_refs,payload_text,payload_hash) VALUES($1,$2,$3,$4::jsonb,$5,$6)", p["id"], a.SubjectID, input.ConsentID, refs, input.PayloadJSON, hash); e != nil {
					return nil, e
				}
			}
		} else {
			prior, e := row(ctx, tx, "SELECT to_jsonb(p) FROM contribution_publications p WHERE id=$1 AND subject_id=$2 FOR UPDATE", p["publicationId"], a.SubjectID)
			if e != nil {
				return nil, e
			}
			if prior == nil || str(prior, "payload_text") == "" {
				return nil, fail("contribution_publication_unavailable", 404)
			}
			if prior["revoked_at"] != nil {
				if prior["revoke_id"] != p["id"] || prior["revoke_consent_id"] != input.ConsentID || prior["revoke_payload_hash"] != hash {
					return nil, fail("contribution_publication_conflict", 409)
				}
			} else if _, e = tx.Exec(ctx, "UPDATE contribution_publications SET revoked_at=$2,revoke_id=$3,revoke_consent_id=$4,revoke_payload_text=$5,revoke_payload_hash=$6 WHERE id=$1", p["publicationId"], time.Unix(s.now(), 0), p["id"], input.ConsentID, input.PayloadJSON, hash); e != nil {
				return nil, e
			}
		}
		scopes, _ := json.Marshal(auth.CredentialScopes)
		if _, e = tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
SELECT $1,$2,$3,$3,'accepted',1,ch.payload->>'installationId',b.audience,'history',c.id,b.id,$4,$3,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=$7 AND c.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$2 AND request_id=$3)`, a.SubjectID, "contribution."+str(p, "kind"), p["id"], a.HTTPRequestID, scopes, a.BindingID, input.ConsentID); e != nil {
			return nil, e
		}
		publicationID := p["id"]
		if p["publicationId"] != nil {
			publicationID = p["publicationId"]
		}
		current, e := row(ctx, tx, "SELECT jsonb_build_object('revoked_at',revoked_at) FROM contribution_publications WHERE id=$1", publicationID)
		if e != nil {
			return nil, e
		}
		state := "published"
		if current["revoked_at"] != nil {
			state = "revoked"
		}
		return Object{"operationId": p["id"], "publicationId": publicationID, "state": state, "originalPermissionsChanged": false, "publicationScope": PublicationScope, "otherPublicationGrantsRevoked": false}, nil
	})
}
