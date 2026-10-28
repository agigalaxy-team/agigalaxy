package recruitment

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/jackc/pgx/v5"
	"unicode/utf8"
)

func (s *Service) Submit(ctx context.Context, a Actor, raw []byte) (Object, error) {
	var envelope Object
	if protocol.Decode(raw, &envelope) != nil || envelope == nil || !strict(envelope, "consentId", "payloadJson") || !opportunities.UUID.MatchString(str(envelope, "consentId")) {
		return nil, invalid()
	}
	payload, ok := envelope["payloadJson"].(string)
	if !ok || utf8.RuneCountInString(payload) < 2 || utf8.RuneCountInString(payload) > 10000 {
		return nil, invalid()
	}
	event, e := ParseEvent([]byte(payload))
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, true, func(tx pgx.Tx, current deviceauth.ControlAuthorization) (Object, error) {
		kind := str(event, "kind")
		var task Object
		if kind == "link-task" {
			if !has(current.CredentialScopes, "assistance") {
				return nil, fail("recruitment_task_scope_required", 403)
			}
			if s.Tasks == nil {
				return nil, fail("recruitment_task_adapter_unavailable", 503)
			}
			if e := s.Devices.AuthorizeWithin(ctx, tx, *a.Device, "assistance"); e != nil {
				return nil, e
			}
			var e error
			task, e = s.Tasks.RequireTaskWithin(ctx, tx, a.Device, str(event, "taskId"), true)
			if e != nil {
				return nil, e
			}
		}
		if s.Projects == nil {
			return nil, fail("recruitment_project_adapter_unavailable", 503)
		}
		project, e := s.Projects.RequireRoleWithin(ctx, tx, *a.Device, str(event, "projectId"), []string{"owner", "representative"}, true)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912361))", event["recruitmentId"]); e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM recruitment_events e WHERE operation_id=$1", event["operationId"])
		if e != nil {
			return nil, e
		}
		receipt := func(revision any, replayed bool) (Object, error) {
			r, e := s.source(ctx, tx, str(event, "recruitmentId"), false)
			if e != nil {
				return nil, e
			}
			out := s.receipt(r)
			out["operationId"], out["appliedRevision"], out["replayed"] = event["operationId"], revision, replayed
			return out, nil
		}
		if prior != nil {
			if prior["subject_id"] != a.Device.SubjectID || prior["recruitment_id"] != event["recruitmentId"] || prior["consent_id"] != envelope["consentId"] || prior["payload_hash"] != identity.Digest([]byte(payload)) {
				return nil, fail("recruitment_operation_conflict", 409)
			}
			return receipt(prior["revision"], true)
		}
		grant, e := s.grant(ctx, tx, Object{"operation_id": event["operationId"], "subject_id": a.Device.SubjectID, "consent_id": envelope["consentId"], "payload_text": payload})
		if e != nil {
			return nil, e
		}
		if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending || !has([]string{"Public", "Private"}, grant.Visibility) {
			return nil, fail("recruitment_write_unavailable", 403)
		}
		var source Object
		if kind == "create" {
			if num(event, "expectedRevision") != 0 || project["state"] != "active" {
				return nil, fail("recruitment_project_unavailable", 409)
			}
			existing, e := row(ctx, tx, "SELECT to_jsonb(o) FROM recruitment_opportunities o WHERE id=$1", event["recruitmentId"])
			if e != nil {
				return nil, e
			}
			if existing != nil {
				return nil, fail("recruitment_id_conflict", 409)
			}
		} else {
			source, e = s.source(ctx, tx, str(event, "recruitmentId"), true)
			if e != nil {
				return nil, e
			}
			if source["project_id"] != event["projectId"] || num(source, "revision") != num(event, "expectedRevision") {
				return nil, fail("recruitment_revision_conflict", 409)
			}
			if source["state"] == "closed" && !has([]string{"link-task", "close"}, kind) {
				return nil, fail("recruitment_closed", 409)
			}
		}
		publishing := has([]string{"create", "revise", "renew"}, kind)
		if publishing {
			if grant.Visibility != "Public" || grant.Purpose != "public-profile" {
				return nil, fail("recruitment_public_consent_required", 403)
			}
			if _, e = s.Projects.ReadWithin(ctx, tx, nil, str(event, "projectId")); e != nil {
				return nil, e
			}
			if source["state"] == "closed" {
				return nil, fail("recruitment_closed", 409)
			}
			if num(event, "expiresAt") <= s.now() || num(event, "expiresAt") > s.now()+30*86400 {
				return nil, fail("recruitment_review_window", 400)
			}
			roles, e := s.Projects.RolesWithin(ctx, tx, project, str(obj(event, "document"), "contactSubjectId"))
			if e != nil {
				return nil, e
			}
			if !has(roles, "owner") && !has(roles, "representative") {
				return nil, fail("recruitment_contact_representative_required", 403)
			}
			if obj(event, "document")["contactSubjectId"] != a.Device.SubjectID {
				return nil, fail("recruitment_contact_self_acceptance_required", 403)
			}
			if s.PublicWrites == nil {
				return nil, fail("recruitment_account_adapter_unavailable", 503)
			}
			_, e = s.PublicWrites.ConsumeWithin(ctx, tx, publicwrites.Actor{Device: a.Device, Scope: "history"}, publicwrites.Operation{Kind: "recruitment", OperationID: str(event, "operationId"), PayloadHash: identity.Digest([]byte(payload)), RecruitmentID: str(event, "recruitmentId")})
			if e != nil {
				return nil, e
			}
		} else if kind == "link-task" {
			if task["requesterId"] != a.Device.SubjectID || num(obj(task, "row"), "version") != num(event, "expectedTaskVersion") {
				return nil, fail("recruitment_task_owner_or_version_required", 403)
			}
			existing, e := row(ctx, tx, "SELECT to_jsonb(l) FROM recruitment_task_links l WHERE recruitment_id=$1 AND task_id=$2", event["recruitmentId"], event["taskId"])
			if e != nil {
				return nil, e
			}
			if existing != nil {
				return nil, fail("recruitment_task_already_linked", 409)
			}
		}
		revision, at := num(event, "expectedRevision")+1, stamp(s.now())
		exec := func(q string, args ...any) error { _, e := tx.Exec(ctx, q, args...); return e }
		if kind == "create" {
			if e = exec("INSERT INTO recruitment_opportunities(id,project_id,creator_id,publisher_id,contact_subject_id,revision,state,current_event_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$3,$4,1,'active',$5,$6,$7,$7)", event["recruitmentId"], event["projectId"], a.Device.SubjectID, obj(event, "document")["contactSubjectId"], event["operationId"], stamp(num(event, "expiresAt")), at); e != nil {
				return nil, e
			}
		}
		if e = exec("INSERT INTO recruitment_events(operation_id,recruitment_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", event["operationId"], event["recruitmentId"], a.Device.SubjectID, revision, kind, envelope["consentId"], payload, identity.Digest([]byte(payload)), at); e != nil {
			return nil, e
		}
		if source != nil {
			if e = exec("UPDATE recruitment_opportunities SET revision=$2,updated_at=$3 WHERE id=$1", event["recruitmentId"], revision, at); e != nil {
				return nil, e
			}
			if publishing {
				if e = exec("UPDATE recruitment_opportunities SET publisher_id=$2,contact_subject_id=$3,current_event_id=$4,expires_at=$5,state='active' WHERE id=$1", source["id"], a.Device.SubjectID, obj(event, "document")["contactSubjectId"], event["operationId"], stamp(num(event, "expiresAt"))); e != nil {
					return nil, e
				}
			}
			if kind == "pause" || kind == "close" {
				state := "paused"
				if kind == "close" {
					state = "closed"
				}
				if e = exec("UPDATE recruitment_opportunities SET state=$2 WHERE id=$1", source["id"], state); e != nil {
					return nil, e
				}
			}
		}
		if kind == "link-task" {
			if e = exec("INSERT INTO recruitment_task_links(recruitment_id,task_id,subject_id,operation_id,created_at) VALUES($1,$2,$3,$4,$5)", event["recruitmentId"], event["taskId"], a.Device.SubjectID, event["operationId"], at); e != nil {
				return nil, e
			}
		}
		if e = s.audit(ctx, tx, a, event, current); e != nil {
			return nil, e
		}
		return receipt(revision, false)
	})
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a Actor, event Object, current deviceauth.ControlAuthorization) error {
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,'recruitment.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'history',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=(SELECT consent_id FROM recruitment_events WHERE operation_id=$2::text::uuid AND subject_id=$1) AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action='recruitment.event' AND object_id=$2::text)`, a.Device.SubjectID, event["operationId"], nullable(a.RequestID), encode(current.CredentialScopes), a.Device.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("audit context unavailable")
	}
	return nil
}
