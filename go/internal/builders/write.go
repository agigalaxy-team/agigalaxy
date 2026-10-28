package builders

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicfetch"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	whatwg "github.com/nlnwa/whatwg-url/url"
)

func equal(a, b any) bool {
	x, _ := protocol.EncodeJS(a)
	y, _ := protocol.EncodeJS(b)
	return string(x) == string(y)
}
func sameViewers(a, b []string) bool {
	x := append([]string{}, a...)
	y := append([]string{}, b...)
	sort.Strings(x)
	sort.Strings(y)
	return equal(x, y)
}
func (s *Service) visibility(grant, current deviceauth.ConsentIntent, assessor bool, owner string) bool {
	if grant.Visibility != "Private" && grant.Visibility != "Public" || grant.Visibility != current.Visibility {
		return false
	}
	if !assessor {
		return sameViewers(grant.Viewers, current.Viewers)
	}
	if grant.Visibility == "Private" {
		if !contains(grant.Viewers, owner) {
			return false
		}
		for _, v := range grant.Viewers {
			if v != owner && !contains(current.Viewers, v) {
				return false
			}
		}
	}
	return true
}
func (s *Service) appendEvent(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, event Object, consent, payload, requestID string, revision int64) (Object, error) {
	_, e := tx.Exec(ctx, "INSERT INTO builder_events(id,builder_id,subject_id,revision,kind,consent_id,payload_text,payload_hash,received_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", event["id"], event["builderId"], a.SubjectID, revision, event["kind"], consent, payload, identity.Digest([]byte(payload)), s.now())
	if e != nil {
		return nil, e
	}
	if _, e = tx.Exec(ctx, "UPDATE builders SET revision=$2 WHERE id=$1", event["builderId"], revision); e != nil {
		return nil, e
	}
	if e = s.audit(ctx, tx, a, auth, txt(event, "id"), "builder.event", requestID); e != nil {
		return nil, e
	}
	return Object{"builderId": event["builderId"], "eventId": event["id"], "revision": revision}, nil
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, id, action, requestID string) error {
	target := "SELECT consent_id FROM builder_events WHERE id=$2::text::uuid AND subject_id=$1"
	if action == "worker-pack.event" {
		target = "SELECT consent_id FROM worker_pack_use_events WHERE operation_id=$2::text::uuid AND subject_id=$1"
	}
	var rid any
	if requestID != "" {
		rid = requestID
	}
	scopes, _ := json.Marshal(auth.CredentialScopes)
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
 SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'builders',c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE c.id=(`+target+`) AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$3 AND object_id=$2::text)`, a.SubjectID, id, action, rid, string(scopes), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	row, e := one(ctx, tx, "SELECT sequence FROM audit_events WHERE actor=$1 AND action=$2 AND object_id=$3", a.SubjectID, action, id)
	if e != nil {
		return e
	}
	if row == nil {
		return fmt.Errorf("builder audit context unavailable")
	}
	return nil
}
func (s *Service) ExtensionPublish(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	input, e := parse("builderExtensionWriteSchema", raw)
	if e != nil {
		return nil, e
	}
	event, e := parsePayload("builderExtensionEventSchema", input, 28000)
	if e != nil {
		return nil, e
	}
	payload := txt(input, "payloadJson")
	return s.run(ctx, &a, true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		b, e := s.load(ctx, tx, txt(event, "builderId"), true)
		if e != nil {
			return nil, e
		}
		assessor := event["kind"] == "scope-report"
		owner := txt(b.parent, "owner_id")
		if assessor && (a.SubjectID == owner || !contains(s.AssessorIDs, a.SubjectID)) {
			return nil, fault.New("builder_assessor_required", 403)
		}
		if !assessor && a.SubjectID != owner {
			return nil, fault.New("builder_owner_required", 403)
		}
		g, e := s.grant(ctx, tx, Object{"id": event["id"], "subject_id": a.SubjectID, "consent_id": input["consentId"], "payload_text": payload}, false)
		if e != nil {
			return nil, e
		}
		prior, e := one(ctx, tx, "SELECT builder_id::text,subject_id,payload_hash,consent_id::text,id::text,revision FROM builder_events WHERE id=$1", event["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["builder_id"] != event["builderId"] || prior["subject_id"] != a.SubjectID || prior["payload_hash"] != identity.Digest([]byte(payload)) || prior["consent_id"] != input["consentId"] {
				return nil, fault.New("builder_event_conflict", 409)
			}
			return Object{"builderId": event["builderId"], "eventId": prior["id"], "revision": prior["revision"]}, nil
		}
		if num(b.parent, "revision") != num(event, "expectedRevision") || num(b.parent, "revision") >= 1000 {
			return nil, fault.New("builder_revision_conflict", 409)
		}
		declaration, current, e := s.current(ctx, tx, &a, b)
		if e != nil {
			return nil, e
		}
		if event["declarationId"] != b.declaration["id"] || event["declarationHash"] != b.declaration["payload_hash"] {
			return nil, fault.New("builder_declaration_changed", 409)
		}
		if !s.visibility(g, current, assessor, owner) {
			return nil, fault.New("builder_visibility_mismatch", 403)
		}
		switch event["kind"] {
		case "pack-manifest":
			if b.parent["type"] != "worker" {
				return nil, fault.New("builder_worker_required", 409)
			}
			manifest := obj(event["manifest"])
			release := obj(declaration["release"])
			if manifest["version"] != release["version"] || manifest["sha256"] != release["buildHash"] || manifest["source"] != release["artifact"] {
				return nil, fault.New("builder_pack_release_mismatch", 409)
			}
		case "support-profile":
			support := obj(event["support"])
			if obj(support["implementation"])["version"] != obj(declaration["release"])["version"] {
				return nil, fault.New("builder_support_release_mismatch", 409)
			}
			if b.parent["type"] == "bridge" {
				mapping := obj(support["mapping"])
				if mapping == nil {
					return nil, fault.New("builder_mapping_required", 409)
				}
				for _, key := range []string{"version", "sourceSystem", "strengthCeiling"} {
					if mapping[key] != obj(declaration["mapping"])[key] {
						return nil, fault.New("builder_mapping_mismatch", 409)
					}
				}
			}
		case "scope-report":
			support := latest(b.rows, "support-profile")
			v := eventOf(support)
			allowed, e := s.permitted(ctx, tx, &a, support)
			if e != nil {
				return nil, e
			}
			if !allowed || v == nil || support["id"] != event["supportId"] || support["payload_hash"] != event["supportHash"] || v["declarationId"] != event["declarationId"] || v["declarationHash"] != event["declarationHash"] {
				return nil, fault.New("builder_support_changed", 409)
			}
			for _, c := range arr(event["checks"]) {
				found := false
				for _, action := range arr(obj(v["support"])["objectActions"]) {
					found = found || action == obj(c)["action"]
				}
				if !found {
					return nil, fault.New("builder_support_changed", 409)
				}
			}
			if num(event, "observedAt") > s.now() || num(event, "observedAt") < s.now()-2592000 || num(event, "expiresAt") <= s.now() || num(event, "expiresAt") <= num(event, "observedAt") || num(event, "expiresAt")-num(event, "observedAt") > 2592000 {
				return nil, fault.New("builder_report_mismatch", 409)
			}
			run := obj(event["run"])
			if run["testClass"] == "independent-interop" && run["peer"] == nil {
				return nil, fault.New("builder_report_peer_required", 409)
			}
			for _, r := range b.rows {
				if r["kind"] == "scope-report" && r["subject_id"] == a.SubjectID && obj(eventOf(r)["run"])["id"] == run["id"] {
					return nil, fault.New("builder_report_run_exists", 409)
				}
			}
		}
		return s.appendEvent(ctx, tx, a, auth, event, txt(input, "consentId"), payload, requestID, num(b.parent, "revision")+1)
	})
}
func probeTarget(v Object) (Object, error) {
	if v["protocol"] != "a2a/1.0" || v["transport"] != "JSONRPC" {
		return nil, fault.New("builder_probe_target_required", 409)
	}
	out := clone(v)
	for _, key := range []string{"endpoint", "cardUrl"} {
		u, e := whatwg.Parse(txt(v, key))
		if e != nil || !publicfetch.ValidURL(u.String()) {
			return nil, fault.New("builder_probe_target_required", 409)
		}
		out[key] = u.String()
	}
	return out, nil
}
func (s *Service) Publish(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	var input Object
	if protocol.Decode(raw, &input) != nil || len(input) != 2 || txt(input, "consentId") == "" {
		return nil, fault.New("invalid_builder_payload", 400)
	}
	event, e := parsePayload("builderEventSchema", input, 28000)
	if e != nil {
		return nil, e
	}
	payload := txt(input, "payloadJson")
	kind := txt(event, "kind")
	control := kind == "node-control-revoke" || kind == "work-evidence-revoke" || kind == "maintenance" && (event["action"] == "delist" || event["action"] == "security-issue")
	return s.run(ctx, &a, true, control, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		if kind == "declare" && num(event, "expectedRevision") == 0 {
			if _, e := tx.Exec(ctx, "INSERT INTO builders(id,owner_id,type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", event["builderId"], a.SubjectID, obj(event["declaration"])["type"]); e != nil {
				return nil, e
			}
		}
		b, e := s.load(ctx, tx, txt(event, "builderId"), true)
		if e != nil {
			return nil, e
		}
		owner := txt(b.parent, "owner_id")
		assessor := kind == "compatibility"
		node := contains([]string{"node-control", "node-control-revoke", "work-evidence", "work-evidence-revoke", "probe-request"}, kind)
		if !node {
			if assessor && (a.SubjectID == owner || !contains(s.AssessorIDs, a.SubjectID)) {
				return nil, fault.New("builder_assessor_required", 403)
			}
			if !assessor && a.SubjectID != owner {
				return nil, fault.New("builder_owner_required", 403)
			}
		}
		g, e := s.grant(ctx, tx, Object{"id": event["id"], "subject_id": a.SubjectID, "consent_id": input["consentId"], "payload_text": payload}, false)
		if e != nil {
			return nil, e
		}
		if g.Visibility != "Private" && g.Visibility != "Public" {
			return nil, fault.New("builder_visibility_required", 403)
		}
		prior, e := one(ctx, tx, "SELECT builder_id::text,subject_id,consent_id::text,payload_hash,id::text,revision FROM builder_events WHERE id=$1", event["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["builder_id"] != b.parent["id"] || prior["subject_id"] != a.SubjectID || prior["consent_id"] != input["consentId"] || prior["payload_hash"] != identity.Digest([]byte(payload)) {
				return nil, fault.New("builder_event_conflict", 409)
			}
			return Object{"builderId": b.parent["id"], "eventId": prior["id"], "revision": prior["revision"]}, nil
		}
		if num(b.parent, "revision") != num(event, "expectedRevision") || num(b.parent, "revision") >= 1000 {
			return nil, fault.New("builder_revision_conflict", 409)
		}
		if kind == "declare" {
			declaration := obj(event["declaration"])
			if declaration["type"] != b.parent["type"] {
				return nil, fault.New("builder_type_immutable", 409)
			}
			for _, proofID := range arr(declaration["proofIds"]) {
				if s.Proofs == nil {
					return nil, fault.New("builder_proof_service_unavailable", 503)
				}
				row, e := one(ctx, tx, "SELECT subject_id FROM proofs WHERE id=$1", proofID)
				if e != nil {
					return nil, e
				}
				if row["subject_id"] != owner {
					return nil, fault.New("builder_proof_owner_mismatch", 409)
				}
				if _, e = s.Proofs.ReadWithin(ctx, tx, &a, proofID.(string), false); e != nil {
					return nil, e
				}
			}
		} else {
			declaration, current, e := s.current(ctx, tx, &a, b)
			currentAvailable := e == nil
			if e != nil {
				if !missing(e) || a.SubjectID != owner || kind != "maintenance" || !contains([]string{"delist", "correction", "security-issue"}, txt(event, "action")) || b.declaration == nil {
					return nil, e
				}
				declaration = obj(eventOf(b.declaration)["declaration"])
			}
			if event["declarationId"] != b.declaration["id"] {
				return nil, fault.New("builder_declaration_changed", 409)
			}
			if node && (declaration["type"] != "worker" || (contains([]string{"node-control", "work-evidence", "probe-request"}, kind) && a.SubjectID != txt(declaration, "nodeId")) || (!contains([]string{"node-control", "work-evidence", "probe-request"}, kind) && a.SubjectID != owner && a.SubjectID != txt(declaration, "nodeId"))) {
				return nil, fault.New("builder_node_holder_required", 403)
			}
			if currentAvailable && !s.visibility(g, current, assessor || node && a.SubjectID != owner, owner) {
				return nil, fault.New("builder_visibility_mismatch", 403)
			}
			if assessor && (event["declarationHash"] != b.declaration["payload_hash"] || num(event, "observedAt") > s.now() || num(event, "observedAt") < s.now()-2592000 || num(event, "expiresAt") <= s.now() || num(event, "expiresAt") <= num(event, "observedAt") || num(event, "expiresAt")-num(event, "observedAt") > 2592000) {
				return nil, fault.New("builder_report_mismatch", 409)
			}
			if kind == "node-control" && (event["declarationHash"] != b.declaration["payload_hash"] || event["ownerId"] != owner || event["nodeId"] != declaration["nodeId"] || num(event, "expiresAt") <= s.now() || num(event, "expiresAt") > g.ExpiresAt) {
				return nil, fault.New("builder_node_control_mismatch", 409)
			}
			if kind == "node-control-revoke" {
				var original Object
				revoked := false
				for _, r := range b.rows {
					v := eventOf(r)
					if r["kind"] == "node-control" && v["declarationId"] == b.declaration["id"] {
						original = r
					}
					if r["kind"] == "node-control-revoke" && v["controlId"] == event["controlId"] {
						revoked = true
					}
				}
				if original == nil || original["id"] != event["controlId"] || revoked {
					return nil, fault.New("builder_node_control_unavailable", 409)
				}
			}
			if kind == "work-evidence" || kind == "probe-request" {
				nodeControl, e := s.nodeControl(ctx, tx, &a, b, declaration)
				if e != nil {
					return nil, e
				}
				if nodeControl["state"] != "node-authorized-owner" || event["controlId"] != nodeControl["controlId"] || event["nodeId"] != a.SubjectID || event["declarationHash"] != b.declaration["payload_hash"] {
					return nil, fault.New("builder_work_node_authorization_required", 409)
				}
				if kind == "work-evidence" {
					if _, e = s.workSources(ctx, tx, &a, event); e != nil {
						return nil, e
					}
					if g.Visibility == "Public" {
						if _, e = s.workSources(ctx, tx, nil, event); e != nil {
							return nil, e
						}
					}
				} else {
					target, e := probeTarget(obj(event["target"]))
					if e != nil {
						return nil, e
					}
					original, e := probeTarget(obj(declaration["a2a"]))
					if e != nil || !equal(target, original) {
						return nil, fault.New("builder_probe_target_required", 409)
					}
					state := maintenance(b.rows)
					if state["delisted"] == true || state["securityIssue"] == true {
						return nil, fault.New("builder_probe_maintenance_blocked", 409)
					}
					last := latest(b.rows, "probe-request")
					if last != nil && s.now()-num(last, "received_at") < 60 {
						return nil, fault.New("builder_probe_cooldown", 429)
					}
				}
			}
			if kind == "work-evidence-revoke" {
				found, revoked := false, false
				for _, r := range b.rows {
					if r["id"] == event["workEventId"] && r["kind"] == "work-evidence" {
						found = true
					}
					if r["kind"] == "work-evidence-revoke" && eventOf(r)["workEventId"] == event["workEventId"] {
						revoked = true
					}
				}
				if !found || revoked {
					return nil, fault.New("builder_work_revoke_unavailable", 409)
				}
			}
			if kind == "maintenance" {
				state := maintenance(b.rows)
				action := event["action"]
				if action == "delist" && state["delisted"] == true || action == "relist" && state["delisted"] != true || action == "security-issue" && state["securityIssue"] == true || action == "resolve-security" && state["securityIssue"] != true {
					return nil, fault.New("builder_transition_denied", 409)
				}
			}
		}
		result, e := s.appendEvent(ctx, tx, a, auth, event, txt(input, "consentId"), payload, requestID, num(b.parent, "revision")+1)
		if e != nil {
			return nil, e
		}
		if kind == "probe-request" {
			origins := []string{}
			for _, key := range []string{"endpoint", "cardUrl"} {
				u, _ := whatwg.Parse(txt(obj(event["target"]), key))
				origin := u.Protocol() + "//" + u.Host()
				if !contains(origins, origin) {
					origins = append(origins, origin)
				}
			}
			raw, _ := protocol.Encode(Object{"builderId": b.parent["id"], "requestId": event["id"], "subjectId": a.SubjectID, "origins": origins})
			if _, e = tx.Exec(ctx, "INSERT INTO jobs(id,kind,deduplication_key,payload,available_at) VALUES($1,'builder-probe',$2,$3,$4)", uuid.NewString(), "builder-probe:"+txt(event, "id"), raw, time.Unix(s.now(), 0)); e != nil {
				return nil, e
			}
		}
		return result, nil
	})
}
