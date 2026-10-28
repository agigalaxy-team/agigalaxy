package projects

import (
	"context"

	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/resourcebudget"
	"github.com/jackc/pgx/v5"
	"time"
	"unicode/utf8"
)

type Actor struct {
	Device    *deviceauth.Actor
	RequestID string
}

func encode(v any) []byte { b, _ := protocol.Encode(v); return b }
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func (s *Service) run(ctx context.Context, a Actor, write bool, fn func(pgx.Tx, deviceauth.ControlAuthorization) (Object, error)) (Object, error) {
	if write && a.Device != nil {
		if e := deviceauth.CheckInformationWatchWrite(*a.Device, "history"); e != nil {
			return nil, e
		}
	}
	if write && a.Device == nil {
		return nil, fail("access_denied", 401)
	}
	return postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Object, error) {
		var current deviceauth.ControlAuthorization
		authorize := func(ctx context.Context, tx pgx.Tx) error {
			if a.Device == nil {
				return nil
			}
			if s.Devices == nil {
				return fail("project_service_unavailable", 503)
			}
			var e error
			current, e = s.Devices.CurrentControlWithin(ctx, tx, *a.Device, "history")
			return e
		}
		if !write {
			if e := authorize(ctx, tx); e != nil {
				return nil, e
			}
			return fn(tx, current)
		}
		budget := s.Resources
		if budget == nil {
			budget, _ = resourcebudget.New(nil, s.Now)
		}
		result, e := budget.ResourceWrite(ctx, tx, resourcebudget.Actor{SubjectID: a.Device.SubjectID}, authorize, func(_ context.Context, tx pgx.Tx) (any, error) { return fn(tx, current) }, resourcebudget.Options{})
		if e != nil {
			return nil, e
		}
		return result.(map[string]any), nil
	})
}
func (s *Service) Submit(ctx context.Context, a Actor, raw []byte) (Object, error) {
	var envelope Object
	if protocol.Decode(raw, &envelope) != nil || envelope == nil || !strict(envelope, "consentId", "payloadJson") || !uuidPattern.MatchString(str(envelope, "consentId")) {
		return nil, projectError()
	}
	payload, ok := envelope["payloadJson"].(string)
	if !ok || utf8.RuneCountInString(payload) < 2 || utf8.RuneCountInString(payload) > 16000 {
		return nil, projectError()
	}
	event, e := ParseEvent([]byte(payload))
	if e != nil {
		return nil, projectError()
	}
	return s.run(ctx, a, true, func(tx pgx.Tx, authorization deviceauth.ControlAuthorization) (Object, error) {
		if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,734912358))", event["projectId"]); e != nil {
			return nil, e
		}
		prior, e := row(ctx, tx, "SELECT to_jsonb(e) FROM project_events_v2 e WHERE operation_id=$1", event["operationId"])
		if e != nil {
			return nil, e
		}
		receipt := func(revision any, replayed bool) Object {
			return Object{"operationId": event["operationId"], "projectId": event["projectId"], "revision": revision, "applied": true, "replayed": replayed}
		}
		if prior != nil {
			if str(prior, "subject_id") != a.Device.SubjectID || prior["project_id"] != event["projectId"] || prior["consent_id"] != envelope["consentId"] || str(prior, "payload_hash") != identity.Digest([]byte(payload)) {
				return nil, fail("project_operation_conflict", 409)
			}
			return receipt(prior["revision"], true), nil
		}
		grant, e := s.grant(ctx, tx, Object{"operation_id": event["operationId"], "subject_id": a.Device.SubjectID, "consent_id": envelope["consentId"], "payload_text": payload})
		if e != nil {
			return nil, e
		}
		if !contains([]string{"Public", "Private"}, grant.Visibility) || grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
			return nil, fail("project_write_unavailable", 403)
		}
		if grant.Visibility == "Public" {
			if s.Links == nil {
				return nil, fail("project_account_adapter_unavailable", 503)
			}
			_, e := s.Links.ForScope("history").ResolveWithin(ctx, tx, *a.Device, "", false)
			if e != nil {
				return nil, e
			}
		}
		kind, id := str(event, "kind"), str(event, "projectId")
		var p, document, transfer Object
		if kind == "create" {
			if num(event, "expectedRevision") != 0 {
				return nil, fail("project_revision_conflict", 409)
			}
			existing, e := row(ctx, tx, "SELECT to_jsonb(p) FROM projects_v2 p WHERE id=$1", id)
			if e != nil {
				return nil, e
			}
			if existing != nil {
				return nil, fail("project_id_conflict", 409)
			}
			document = obj(event, "document")
			if event["sourceStatementId"] != nil {
				if s.Profiles == nil {
					return nil, fail("project_import_source_unavailable", 404)
				}
				profile, e := s.Profiles.ReadForContactWithin(ctx, tx, a.Device.SubjectID, a.Device.SubjectID)
				if e != nil {
					return nil, e
				}
				var old Object
				for _, item := range func() []any { values, _ := obj(profile, "selfDeclared")["projects"].([]any); return values }() {
					candidate, _ := item.(map[string]any)
					if str(candidate, "id") == id {
						old = candidate
						break
					}
				}
				if old == nil || obj(profile, "selfDeclaredSource")["id"] != event["sourceStatementId"] {
					return nil, fail("project_import_source_unavailable", 404)
				}
				delete(old, "id")
				original, e := ParseDocument(old, false)
				if e != nil {
					return nil, e
				}
				left, e := identity.Canonical(original)
				if e != nil {
					return nil, e
				}
				right, e := identity.Canonical(document)
				if e != nil {
					return nil, e
				}
				if string(left) != string(right) {
					return nil, fail("project_import_must_preserve_source", 400)
				}
			}
		} else {
			p, e = s.project(ctx, tx, id, true)
			if e != nil {
				return nil, e
			}
			if num(p, "revision") != num(event, "expectedRevision") {
				return nil, fail("project_revision_conflict", 409)
			}
			roles, e := s.RolesWithin(ctx, tx, p, a.Device.SubjectID)
			if e != nil {
				return nil, e
			}
			owner := contains(roles, "owner")
			if kind == "revise" {
				if !owner && !contains(roles, "editor") {
					return nil, fail("project_editor_required", 403)
				}
				var previous Object
				if owner {
					previous, e = s.DocumentWithin(ctx, tx, a.Device.SubjectID, p, true)
				} else {
					previous, e = s.readWithin(ctx, tx, a.Device.SubjectID, id, false, false)
				}
				if e != nil {
					return nil, e
				}
				merged := Object{}
				for k, v := range obj(previous, "document") {
					merged[k] = v
				}
				for k, v := range obj(event, "patch") {
					merged[k] = v
				}
				if merged["sourceUrl"] == nil {
					delete(merged, "sourceUrl")
				}
				document, e = ParseDocument(merged, false)
				if e != nil {
					return nil, e
				}
				if !owner {
					for _, key := range []string{"discoverable", "participantKind"} {
						if _, ok := obj(event, "patch")[key]; ok {
							return nil, fail("project_owner_setting_required", 403)
						}
					}
				}
			} else if kind == "accept-transfer" {
				transfer, e = row(ctx, tx, "SELECT to_jsonb(t) FROM project_transfers_v2 t WHERE id=$1 AND project_id=$2 FOR UPDATE", event["transferId"], id)
				if e != nil {
					return nil, e
				}
				if transfer == nil || str(transfer, "state") != "offered" || str(transfer, "to_subject_id") != a.Device.SubjectID || transfer["from_subject_id"] != p["owner_id"] {
					return nil, fail("project_transfer_unavailable", 409)
				}
				source, e := row(ctx, tx, "SELECT to_jsonb(e) FROM project_events_v2 e WHERE operation_id=$1", transfer["offer_event_id"])
				if e != nil {
					return nil, e
				}
				if _, e = s.grant(ctx, tx, source); e != nil {
					return nil, e
				}
				if _, e = s.readWithin(ctx, tx, a.Device.SubjectID, id, false, false); e != nil {
					return nil, e
				}
			} else if !owner {
				return nil, fail("project_owner_required", 403)
			}
			if str(p, "state") != "active" && !contains([]string{"restore", "cancel-transfer"}, kind) {
				return nil, fail("project_archived", 409)
			}
			if kind == "grant-role" {
				if event["subjectId"] == p["owner_id"] {
					return nil, fail("project_owner_role_implicit", 409)
				}
				managed, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM (SELECT DISTINCT subject_id FROM project_roles_v2 WHERE project_id=$1 AND state='active') r", id)
				if e != nil {
					return nil, e
				}
				found := false
				for _, r := range managed {
					found = found || r["subject_id"] == event["subjectId"]
				}
				if len(managed) >= 9 && !found {
					return nil, fail("project_manager_limit", 409)
				}
			}
			if kind == "offer-transfer" {
				pending, e := rows(ctx, tx, "SELECT to_jsonb(t) FROM project_transfers_v2 t WHERE project_id=$1 AND state='offered'", id)
				if e != nil {
					return nil, e
				}
				if event["toSubjectId"] == p["owner_id"] || len(pending) > 0 {
					return nil, fail("project_transfer_conflict", 409)
				}
			}
			if kind == "cancel-transfer" {
				transfer, e = row(ctx, tx, "SELECT to_jsonb(t) FROM project_transfers_v2 t WHERE id=$1 AND project_id=$2 FOR UPDATE", event["transferId"], id)
				if e != nil {
					return nil, e
				}
				if transfer == nil || str(transfer, "state") != "offered" || transfer["from_subject_id"] != p["owner_id"] {
					return nil, fail("project_transfer_unavailable", 409)
				}
			}
		}
		if document != nil {
			b, e := documentBytes(document, event, payload)
			if e != nil {
				return nil, e
			}
			if protocol.TextLength(string(b)) > 14000 {
				return nil, fail("project_document_too_large", 413)
			}
		}
		revision, at := num(event, "expectedRevision")+1, time.Unix(s.now(), 0)
		exec := func(sql string, args ...any) error { _, e := tx.Exec(ctx, sql, args...); return e }
		if kind == "create" {
			if e = exec("INSERT INTO projects_v2(id,creator_id,owner_id,revision,state,document_event_id,policy_event_id,source_statement_id,created_at,updated_at) VALUES($1,$2,$2,1,'active',$3,$3,$4,$5,$5)", id, a.Device.SubjectID, event["operationId"], event["sourceStatementId"], at); e != nil {
				return nil, e
			}
		}
		fields := []string{}
		values := obj(event, "patch")
		if kind == "create" {
			values = obj(event, "document")
		}
		if values != nil {
			for _, key := range orderedKeys([]byte(payload), kind == "create") {
				if _, ok := values[key]; ok {
					fields = append(fields, key)
				}
			}
		}
		if e = exec("INSERT INTO project_events_v2(operation_id,project_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,affected_fields,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", event["operationId"], id, a.Device.SubjectID, revision, kind, envelope["consentId"], payload, identity.Digest([]byte(payload)), encode(fields), at); e != nil {
			return nil, e
		}
		if kind == "create" || kind == "accept-transfer" || kind == "revise" && str(p, "owner_id") == a.Device.SubjectID {
			fields = append(fields, "@policy")
		}
		for _, field := range fields {
			if e = exec("INSERT INTO project_field_sources_v2(project_id,field_name,event_id) VALUES($1,$2,$3) ON CONFLICT(project_id,field_name) DO UPDATE SET event_id=$3", id, field, event["operationId"]); e != nil {
				return nil, e
			}
		}
		if kind != "create" {
			if e = exec("UPDATE projects_v2 SET revision=$2,updated_at=$3 WHERE id=$1", id, revision, at); e != nil {
				return nil, e
			}
		}
		switch kind {
		case "revise":
			e = exec("UPDATE projects_v2 SET document_event_id=$2,policy_event_id=CASE WHEN owner_id=$3 THEN $2 ELSE policy_event_id END WHERE id=$1", id, event["operationId"], a.Device.SubjectID)
		case "grant-role":
			e = exec("INSERT INTO project_roles_v2(project_id,subject_id,role,grant_event_id,state,created_at,updated_at) VALUES($1,$2,$3,$4,'active',$5,$5) ON CONFLICT(project_id,subject_id,role) DO UPDATE SET grant_event_id=$4,revoke_event_id=NULL,state='active',updated_at=$5", id, event["subjectId"], event["role"], event["operationId"], at)
		case "revoke-role":
			e = exec("UPDATE project_roles_v2 SET state='revoked',revoke_event_id=$4,updated_at=$5 WHERE project_id=$1 AND subject_id=$2 AND role=$3", id, event["subjectId"], event["role"], event["operationId"], at)
		case "offer-transfer":
			e = exec("INSERT INTO project_transfers_v2(id,project_id,from_subject_id,to_subject_id,state,offer_event_id,created_at,updated_at) VALUES($1,$2,$3,$4,'offered',$5,$6,$6)", event["transferId"], id, a.Device.SubjectID, event["toSubjectId"], event["operationId"], at)
		case "archive", "restore":
			state := "active"
			if kind == "archive" {
				state = "archived"
			}
			e = exec("UPDATE projects_v2 SET state=$2 WHERE id=$1", id, state)
		}
		if e != nil {
			return nil, e
		}
		if transfer != nil {
			state := "cancelled"
			if kind == "accept-transfer" {
				state = "accepted"
			}
			if e = exec("UPDATE project_transfers_v2 SET state=$2,response_event_id=$3,updated_at=$4 WHERE id=$1", transfer["id"], state, event["operationId"], at); e != nil {
				return nil, e
			}
			if kind == "accept-transfer" {
				if e = exec("UPDATE projects_v2 SET owner_id=$2,policy_event_id=$3 WHERE id=$1", id, a.Device.SubjectID, event["operationId"]); e != nil {
					return nil, e
				}
				if e = exec("UPDATE project_roles_v2 SET state='revoked',revoke_event_id=$3,updated_at=$4 WHERE project_id=$1 AND subject_id=$2", id, a.Device.SubjectID, event["operationId"], at); e != nil {
					return nil, e
				}
			}
		}
		if e = s.audit(ctx, tx, a, event, authorization); e != nil {
			return nil, e
		}
		return receipt(revision, false), nil
	})
}

// Object key order does not affect the original JSON.stringify UTF-16 length.
// JCS uses the same ECMAScript number/string representation (including -0),
// unlike encoding/json's retention of json.Number lexical spellings.
func documentBytes(document, event Object, payload string) ([]byte, error) {
	return identity.Canonical(document)
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a Actor, event Object, current deviceauth.ControlAuthorization) error {
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes) SELECT $1,'project.event',$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'history',c.id,b.id,$3,$2::text,b.scopes,$4::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$5::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=(SELECT consent_id FROM project_events_v2 WHERE operation_id=$2::text::uuid AND subject_id=$1) AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action='project.event' AND object_id=$2::text)`, a.Device.SubjectID, event["operationId"], nullable(a.RequestID), encode(current.CredentialScopes), a.Device.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() != 1 {
		return fmt.Errorf("audit context unavailable")
	}
	return nil
}
func unavailable(e error) bool { return e != nil && (fault.Status(e) == 403 || fault.Status(e) == 404) }
