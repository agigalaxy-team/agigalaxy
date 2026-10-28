package qualification

import (
	"context"
	"encoding/json"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) SubmitRequest(ctx context.Context, a Actor, input Envelope) (any, error) {
	x, e := ParseRequestEvent([]byte(input.PayloadJSON))
	if e != nil {
		return nil, e
	}
	if len(input.PayloadJSON) > 48000 {
		return nil, fail("qualification_request_too_large", 413)
	}
	return s.resourceWrite(ctx, a, x["kind"] == "cancel" || x["kind"] == "decline", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (any, error) {
		grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: input.ConsentID, SubjectID: a.SubjectID, ObjectID: str(x, "eventId"), Action: "qualification.request", Recipient: s.Endpoint, PayloadJSON: input.PayloadJSON})
		if e != nil {
			return nil, e
		}
		hash := identity.Digest([]byte(input.PayloadJSON))
		prior, e := readRow(ctx, tx, "SELECT to_jsonb(e) FROM qualification_permission_request_events e WHERE id=$1", x["eventId"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["subject_id"] != a.SubjectID || prior["request_id"] != x["requestId"] || prior["payload_hash"] != hash || prior["consent_id"] != input.ConsentID {
				return nil, fail("qualification_request_conflict")
			}
			return Object{"eventId": x["eventId"], "requestId": x["requestId"], "version": prior["version"], "acknowledged": true}, nil
		}
		if s.Assistance == nil {
			return nil, fail("qualification_assistance_unavailable", 503)
		}
		if x["kind"] == "request" {
			if number(x["expectedVersion"]) != 0 {
				return nil, fail("qualification_request_conflict")
			}
			value, e := s.requestSourcesWithin(ctx, tx, a.Actor, Object{"taskId": x["taskId"], "participationIds": x["participationIds"], "externalReviewRefs": x["externalReviewRefs"], "expiresAt": x["expiresAt"]})
			if e != nil {
				return nil, e
			}
			refs := []any{}
			for _, v := range array(value["sources"]) {
				if object(v)["authorId"] == x["sourceAuthorId"] {
					refs = append(refs, cleanRef(object(v)))
				}
			}
			same, e := sameCanonical(sortRefs(refs), sortRefs(array(x["sourceRefs"])))
			if e != nil {
				return nil, e
			}
			if len(refs) == 0 || x["sourceAuthorId"] == a.SubjectID || !same {
				return nil, fail("qualification_request_exact_author_sources_required", 403)
			}
			if s.IsBlockedWithin == nil {
				return nil, fail("qualification_request_inbox_unavailable", 503)
			}
			blocked, e := s.IsBlockedWithin(ctx, tx, a.SubjectID, str(x, "sourceAuthorId"))
			if e != nil {
				return nil, e
			}
			if blocked {
				return nil, fail("qualification_request_blocked", 403)
			}
			if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "qualification-request:"+a.SubjectID+":"+str(x, "sourceAuthorId")+":"+str(x, "taskId")); e != nil {
				return nil, e
			}
			old, e := readRow(ctx, tx, "SELECT jsonb_build_object('id',id,'state',state,'created_at',created_at,'expires_at',expires_at) FROM qualification_permission_requests WHERE subject_id=$1 AND source_author_id=$2 AND task_id=$3 ORDER BY created_at DESC LIMIT 1", a.SubjectID, x["sourceAuthorId"], x["taskId"])
			if e != nil {
				return nil, e
			}
			if old != nil {
				created, e := timestamp(old["created_at"])
				if e != nil {
					return nil, e
				}
				expires, e := timestamp(old["expires_at"])
				if e != nil {
					return nil, e
				}
				if created.UnixMilli() > (s.now()-86400)*1000 || old["state"] == "pending" && expires.UnixMilli() > s.now()*1000 {
					return nil, fail("qualification_request_cooldown", 429)
				}
			}
			scopeHash, e := requestScopeHash(str(x, "taskId"), str(x, "sourceAuthorId"), refs)
			if e != nil {
				return nil, e
			}
			if _, e = tx.Exec(ctx, "INSERT INTO qualification_permission_requests(id,subject_id,source_author_id,task_id,scope_hash,root_event_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", x["requestId"], a.SubjectID, x["sourceAuthorId"], x["taskId"], scopeHash, x["eventId"], x["expiresAt"], time.Unix(s.now(), 0)); e != nil {
				return nil, e
			}
		}
		row, e := readRow(ctx, tx, "SELECT to_jsonb(r) FROM qualification_permission_requests r WHERE id=$1 FOR UPDATE", x["requestId"])
		if e != nil {
			return nil, e
		}
		if row == nil || row["subject_id"] != a.SubjectID && row["source_author_id"] != a.SubjectID {
			return nil, fail("qualification_request_unavailable", 404)
		}
		if grant.Visibility != "Private" || !s.Assistance.LegacySourceVisible(grant, str(row, "subject_id")) || !s.Assistance.LegacySourceVisible(grant, str(row, "source_author_id")) {
			return nil, fail("qualification_request_private_audience_required", 403)
		}
		for _, id := range grant.Viewers {
			if id != row["subject_id"] && id != row["source_author_id"] {
				return nil, fail("qualification_request_private_audience_required", 403)
			}
		}
		if number(row["version"]) != number(x["expectedVersion"]) {
			return nil, fail("qualification_request_version_conflict")
		}
		state := row["state"]
		switch x["kind"] {
		case "cancel":
			if row["subject_id"] != a.SubjectID {
				return nil, fail("qualification_candidate_required", 403)
			}
			if state != "pending" && state != "permission-recorded" {
				return nil, fail("qualification_request_closed")
			}
			state = "cancelled"
		case "decline":
			if row["source_author_id"] != a.SubjectID {
				return nil, fail("qualification_source_author_required", 403)
			}
			if state != "pending" {
				return nil, fail("qualification_request_closed")
			}
			state = "declined"
		case "record-permission":
			expires, e := timestamp(row["expires_at"])
			if e != nil {
				return nil, e
			}
			if row["source_author_id"] != a.SubjectID || state != "pending" || expires.UnixMilli() <= s.now()*1000 {
				return nil, fail("qualification_request_closed")
			}
			root, e := s.requestRoot(ctx, tx, a.Actor, row)
			if e != nil {
				return nil, e
			}
			permission, e := s.readCalculationWithin(ctx, tx, a.Actor, str(x, "grantId"))
			if e != nil {
				return nil, e
			}
			g := permission.Payload
			target, e := readRow(ctx, tx, "SELECT jsonb_build_object('requester_id',requester_id) FROM task_requests WHERE id=$1", row["task_id"])
			if e != nil {
				return nil, e
			}
			same, e := sameCanonical(sortRefs(array(g["sourceRefs"])), sortRefs(array(root["sourceRefs"])))
			if e != nil {
				return nil, e
			}
			gExpiry, _ := parseDatetime(g["expiresAt"])
			if permission.Row["subject_id"] != a.SubjectID || g["kind"] != "source-permission" || g["candidateId"] != row["subject_id"] || g["taskId"] != row["task_id"] || g["recipientId"] != target["requester_id"] || !same || gExpiry.UnixMilli() < expires.UnixMilli() {
				return nil, fail("qualification_request_permission_mismatch")
			}
			state = "permission-recorded"
		}
		version := number(row["version"]) + 1
		if _, e = tx.Exec(ctx, "INSERT INTO qualification_permission_request_events(id,request_id,subject_id,version,kind,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", x["eventId"], row["id"], a.SubjectID, version, x["kind"], input.ConsentID, input.PayloadJSON, hash, time.Unix(s.now(), 0)); e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE qualification_permission_requests SET version=version+1,state=$2 WHERE id=$1", row["id"], state); e != nil {
			return nil, e
		}
		if e = s.auditRequest(ctx, tx, a, auth, str(x, "eventId")); e != nil {
			return nil, e
		}
		return Object{"eventId": x["eventId"], "requestId": row["id"], "version": version, "state": state, "acknowledged": true, "permissionGranted": false}, nil
	})
}
func (s *Service) auditRequest(ctx context.Context, tx pgx.Tx, a Actor, auth deviceauth.ControlAuthorization, id string) error {
	scopes, _ := json.Marshal(auth.CredentialScopes)
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
SELECT $1,'qualification.request.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'assistance',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes
FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id
WHERE c.id=(SELECT consent_id FROM qualification_permission_request_events WHERE id=$2::text::uuid AND subject_id=$1)AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action='qualification.request.event'AND object_id=$2::text)`, a.SubjectID, id, a.HTTPRequestID, scopes, a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM audit_events WHERE actor=$1 AND action='qualification.request.event'AND object_id=$2", a.SubjectID, id).Scan(&count); e != nil {
		return e
	}
	if count != 1 {
		return fail("qualification_request_audit_unavailable", 503)
	}
	return nil
}
func (s *Service) RequestReceipt(ctx context.Context, a Actor, input Object) (any, error) {
	if !queryClosed(input, []string{"eventId", "payloadHash"}, nil) || !uuidPattern.MatchString(str(input, "eventId")) || !sha256Pattern.MatchString(str(input, "payloadHash")) {
		return requestInvalid()
	}
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) {
		r, e := readRow(ctx, tx, "SELECT jsonb_build_object('request_id',request_id,'version',version,'payload_hash',payload_hash,'consent_id',consent_id) FROM qualification_permission_request_events WHERE id=$1 AND subject_id=$2", input["eventId"], a.SubjectID)
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
		out := Object{"eventId": input["eventId"], "state": state, "currentReadPermissionConfirmed": false}
		if state == "acknowledged" {
			out["requestId"], out["version"], out["consentId"] = r["request_id"], r["version"], r["consent_id"]
		}
		return out, nil
	})
}
