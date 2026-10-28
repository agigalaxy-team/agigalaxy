package capsules

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"time"
)

type permission struct {
	row, payload Object
	wire         *protocol.OrderedObject
	grant        deviceauth.ConsentIntent
}

func (s *Service) permissionWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string, allowRevoked bool) (*permission, error) {
	row, e := one(ctx, tx, `SELECT * FROM capsule_permissions WHERE id=$1 FOR SHARE`, id)
	if e != nil {
		return nil, e
	}
	if text(row, "payload_text") == "" {
		return nil, fault.New("capsule_permission_unavailable", 403)
	}
	g, e := s.grant(ctx, tx, row, "capsule.permission")
	if e != nil {
		return nil, e
	}
	if !s.visible(g, a) {
		return nil, fault.New("capsule_permission_unavailable", 403)
	}
	p, e := parsePayload(text(row, "payload_text"), "permission", true)
	if e != nil {
		return nil, e
	}
	o := p.Values()
	if o["kind"] != "grant" {
		return nil, fault.New("capsule_permission_unavailable", 403)
	}
	if !allowRevoked {
		if row["revoked_at"] != nil {
			return nil, fault.New("capsule_permission_revoked", 403)
		}
		if exp := text(o, "expiresAt"); exp != "" {
			t, _ := time.Parse(time.RFC3339Nano, exp)
			if !t.After(time.Unix(s.now(), 0)) {
				return nil, fault.New("capsule_permission_expired", 403)
			}
		}
	}
	return &permission{row: row, payload: o, wire: p, grant: g}, nil
}
func envelope(raw []byte) (Object, error) {
	o, e := protocol.DecodeOrdered(raw)
	if e != nil {
		return nil, fault.New("invalid_request", 400)
	}
	p := obj(o)
	if len(p) != 2 {
		return nil, fault.New("invalid_request", 400)
	}
	if _, ok := p["consentId"]; !ok {
		return nil, fault.New("invalid_request", 400)
	}
	if _, ok := p["payloadJson"]; !ok {
		return nil, fault.New("invalid_request", 400)
	}
	return p, nil
}
func (s *Service) audit(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, auth deviceauth.ControlAuthorization, id, action, requestID string) error {
	target := ""
	switch action {
	case "capsule.event":
		target = `c.id=(SELECT consent_id FROM capsule_events WHERE id=$2::text::uuid AND subject_id=$1)`
	case "capsule.permission":
		target = `c.id=(SELECT consent_id FROM capsule_permissions WHERE id=$2::text::uuid AND subject_id=$1 UNION SELECT revoke_consent_id FROM capsule_permissions WHERE revoke_id=$2::text::uuid AND subject_id=$1)`
	case "capsule.use":
		target = `c.id=(SELECT consent_id FROM capsule_uses WHERE id=$2::text::uuid AND subject_id=$1 UNION SELECT consent_id FROM capsule_uses_v2 WHERE id=$2::text::uuid AND subject_id=$1)`
	default:
		return fmt.Errorf("unsupported capsule audit")
	}
	var rid any
	if requestID != "" {
		rid = requestID
	}
	tag, e := tx.Exec(ctx, `INSERT INTO audit_events(actor,action,object_id,request_id,outcome,context_version,client_id,audience,scope,consent_id,binding_id,http_request_id,idempotency_key,binding_scopes,credential_scopes,caller_binding_id,caller_client_id,caller_audience,caller_binding_scopes)
SELECT $1,$3,$2::text,$2::text,'accepted',1,ch.payload->>'installationId',b.audience,'capsules',c.id,b.id,$4,$2::text,b.scopes,$5::jsonb,cb.id,cch.payload->>'installationId',cb.audience,cb.scopes FROM consents c JOIN bindings b ON b.id=c.binding_id JOIN binding_challenges ch ON ch.id=b.challenge_id JOIN bindings cb ON cb.id=$6::uuid AND cb.subject_id=$1 JOIN binding_challenges cch ON cch.id=cb.challenge_id WHERE `+target+` AND c.subject_id=$1 AND b.subject_id=$1 AND NOT EXISTS(SELECT 1 FROM audit_events WHERE actor=$1 AND action=$3 AND object_id=$2::text)`, a.SubjectID, id, action, rid, string(encode(auth.CredentialScopes)), a.BindingID)
	if e != nil {
		return e
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	var count int
	e = tx.QueryRow(ctx, `SELECT count(*) FROM audit_events WHERE actor=$1 AND action=$2 AND object_id=$3`, a.SubjectID, action, id).Scan(&count)
	if e != nil {
		return e
	}
	if count != 1 {
		return fmt.Errorf("capsule audit context unavailable")
	}
	return nil
}
func (s *Service) Permission(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	in, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	wire, e := parsePayload(text(in, "payloadJson"), "permission", true)
	if e != nil {
		return nil, e
	}
	p := wire.Values()
	return s.run(ctx, &a, true, p["kind"] == "revoke", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		g, e := s.grant(ctx, tx, Object{"id": p["id"], "subject_id": a.SubjectID, "consent_id": in["consentId"], "payload_text": in["payloadJson"]}, "capsule.permission")
		if e != nil {
			return nil, e
		}
		if g.Visibility != "Private" && g.Visibility != "Public" {
			return nil, fault.New("capsule_visibility_required", 403)
		}
		if p["kind"] == "grant" {
			for _, value := range list(p["grantees"]) {
				viewer := deviceauth.Actor{SubjectID: value.(string)}
				if !s.visible(g, &viewer) {
					return nil, fault.New("capsule_grantee_visibility_required", 403)
				}
			}
			if exp := text(p, "expiresAt"); exp != "" {
				at, _ := time.Parse(time.RFC3339Nano, exp)
				if !at.After(time.Unix(s.now(), 0)) {
					return nil, fault.New("capsule_permission_expired", 409)
				}
			}
			for _, value := range list(p["sources"]) {
				source, e := s.SourceWithin(ctx, tx, &a, obj(value), false, nil)
				if e != nil {
					return nil, e
				}
				if source["authorId"] != a.SubjectID {
					return nil, fault.New("capsule_source_author_required", 403)
				}
			}
			prior, e := one(ctx, tx, `SELECT * FROM capsule_permissions WHERE id=$1`, p["id"])
			if e != nil {
				return nil, e
			}
			if prior != nil {
				if prior["subject_id"] != a.SubjectID || prior["consent_id"] != in["consentId"] || prior["payload_hash"] != identity.Digest([]byte(text(in, "payloadJson"))) {
					return nil, fault.New("capsule_permission_conflict", 409)
				}
				state := "recorded"
				if prior["revoked_at"] != nil {
					state = "revoked"
				}
				return Object{"permissionId": p["id"], "state": state, "coauthorApproval": false}, nil
			}
			if _, e = tx.Exec(ctx, `INSERT INTO capsule_permissions(id,subject_id,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5)`, p["id"], a.SubjectID, in["consentId"], in["payloadJson"], identity.Digest([]byte(text(in, "payloadJson")))); e != nil {
				return nil, e
			}
		} else {
			prior, e := one(ctx, tx, `SELECT * FROM capsule_permissions WHERE id=$1 AND subject_id=$2 FOR UPDATE`, p["permissionId"], a.SubjectID)
			if e != nil {
				return nil, e
			}
			if prior == nil {
				return nil, fault.New("capsule_permission_unavailable", 403)
			}
			if prior["revoked_at"] != nil {
				if prior["revoke_id"] != p["id"] || prior["revoke_consent_id"] != in["consentId"] || prior["revoke_payload_hash"] != identity.Digest([]byte(text(in, "payloadJson"))) {
					return nil, fault.New("capsule_permission_conflict", 409)
				}
			} else if _, e = tx.Exec(ctx, `UPDATE capsule_permissions SET revoked_at=$2,revoke_id=$3,revoke_consent_id=$4,revoke_payload_text=$5,revoke_payload_hash=$6 WHERE id=$1`, p["permissionId"], time.Unix(s.now(), 0), p["id"], in["consentId"], in["payloadJson"], identity.Digest([]byte(text(in, "payloadJson")))); e != nil {
				return nil, e
			}
		}
		if e = s.audit(ctx, tx, a, auth, text(p, "id"), "capsule.permission", requestID); e != nil {
			return nil, e
		}
		id := p["id"]
		state := "recorded"
		if p["kind"] == "revoke" {
			id = p["permissionId"]
			state = "revoked"
		}
		return Object{"permissionId": id, "state": state, "authorId": a.SubjectID, "coauthorApproval": false, "legalOwnershipIndependentlyVerified": false}, nil
	})
}

func (s *Service) publicationSources(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, p Object, visibility string, current, includeCoverage bool) (Object, error) {
	resolution := obj(p["sourceResolution"])
	main := Object{"kind": "result", "id": resolution["resultId"], "version": resolution["resultVersion"], "caseId": resolution["caseId"]}
	primary, e := s.SourceWithin(ctx, tx, a, main, current, nil)
	if e != nil {
		return nil, e
	}
	if obj(primary["fact"])["reportedOutcome"] != "succeeded" {
		return nil, fault.New("capsule_resolution_required", 409)
	}
	if p["synthetic"] != true && primary["synthetic"] == true {
		return nil, fault.New("synthetic_mismatch", 409)
	}
	refs := []any{main}
	refs = append(refs, list(p["sourceRefs"])...)
	for _, v := range list(p["attributionRefs"]) {
		refs = append(refs, obj(v)["source"])
	}
	for _, v := range list(resolution["verificationRefs"]) {
		r := obj(v)
		refs = append(refs, Object{"kind": "verification", "id": r["id"], "version": r["version"], "caseId": resolution["caseId"]})
	}
	selected := []Object{}
	indices := map[string]int{}
	for _, v := range refs {
		r := obj(v)
		k := sourceKey(r)
		if i, ok := indices[k]; ok {
			selected[i] = r
		} else {
			indices[k] = len(selected)
			selected = append(selected, r)
		}
	}
	resolved := []any{}
	allDeps := []any{}
	for _, ref := range selected {
		o, e := s.SourceWithin(ctx, tx, a, ref, false, nil)
		if e != nil {
			return nil, e
		}
		if p["synthetic"] != true && o["synthetic"] == true {
			return nil, fault.New("synthetic_mismatch", 409)
		}
		resolved = append(resolved, o)
		allDeps = append(allDeps, list(o["dependencies"])...)
	}
	deps := dependenciesUnique(allDeps)
	coverage := map[string]string{}
	covering := map[string][]any{}
	for _, v := range deps {
		d := obj(v)
		if d["authorId"] == subject(a) {
			coverage[text(d, "key")] = subject(a)
		}
	}
	permissions := []any{}
	for _, v := range list(p["permissionRefs"]) {
		id := v.(string)
		permission, e := s.permissionWithin(ctx, tx, a, id, false)
		if e != nil {
			return nil, e
		}
		license := permission.payload
		grantee := false
		for _, g := range list(license["grantees"]) {
			grantee = grantee || g == subject(a)
		}
		if !grantee {
			return nil, fault.New("capsule_permission_grantee_mismatch", 403)
		}
		if license["license"] != p["license"] {
			return nil, fault.New("capsule_license_mismatch", 403)
		}
		if visibility == "Public" && license["allowPublic"] != true {
			return nil, fault.New("capsule_publication_not_permitted", 403)
		}
		grantor := deviceauth.Actor{SubjectID: text(permission.row, "subject_id")}
		for _, v := range list(license["sources"]) {
			source, e := s.SourceWithin(ctx, tx, &grantor, obj(v), false, nil)
			if e != nil {
				return nil, e
			}
			if source["authorId"] != grantor.SubjectID {
				return nil, fault.New("capsule_source_author_required", 403)
			}
			for _, v := range list(source["dependencies"]) {
				d := obj(v)
				if d["authorId"] == grantor.SubjectID {
					k := text(d, "key")
					coverage[k] = grantor.SubjectID
					found := false
					for _, prior := range covering[k] {
						found = found || prior == id
					}
					if !found {
						covering[k] = append(covering[k], id)
					}
				}
			}
		}
		permissions = append(permissions, Object{"permissionId": id, "authorId": grantor.SubjectID, "license": license["license"], "scope": license["scope"], "basis": license["basis"], "attribution": license["attribution"], "licenseReference": license["licenseReference"], "status": "current-source-permission", "coauthorApproval": false, "legalOwnershipIndependentlyVerified": false})
	}
	uncovered := []any{}
	for _, v := range deps {
		d := obj(v)
		if coverage[text(d, "key")] != text(d, "authorId") {
			uncovered = append(uncovered, d)
		}
	}
	if !includeCoverage && len(uncovered) > 0 {
		return nil, fault.New("capsule_source_permission_required", 403)
	}
	attributions := []any{}
	for _, v := range list(p["attributionRefs"]) {
		attr := obj(v)
		var source Object
		for _, v := range resolved {
			if sourceKey(obj(obj(v)["ref"])) == sourceKey(obj(attr["source"])) {
				source = obj(v)
				break
			}
		}
		if source == nil || source["authorId"] != attr["subjectId"] {
			return nil, fault.New("capsule_attribution_mismatch", 409)
		}
		attributions = append(attributions, Object{"subjectId": attr["subjectId"], "source": attr["source"], "authority": "source-author-observed; publisher-attribution", "contributionResponses": "read-original-intervention-under-its-own-permission", "coauthorApproval": false})
	}
	for _, contributor := range list(p["contributors"]) {
		found := false
		for _, attr := range list(p["attributionRefs"]) {
			found = found || obj(attr)["subjectId"] == contributor
		}
		if !found {
			return nil, fault.New("capsule_contributor_source_required", 409)
		}
	}
	out := Object{"primary": primary, "permissions": permissions, "attributions": attributions, "sourceRefs": refs, "synthetic": p["synthetic"] == true || primary["synthetic"] == true, "sourceCurrent": primary["currentness"] == "current", "sourceCurrentness": primary["currentness"], "capabilityVerified": false}
	if includeCoverage {
		sources := []any{}
		for _, v := range resolved {
			o := obj(v)
			x := Object{"ref": o["ref"], "authorId": o["authorId"], "sourceState": o["sourceState"], "currentness": o["currentness"]}
			if o["reading"] != nil {
				x["reading"] = o["reading"]
			} else if fact := obj(o["fact"]); fact != nil {
				value := ""
				for _, k := range []string{"summary", "description", "strategy"} {
					if v, ok := fact[k].(string); ok {
						value = v
						break
					}
				}
				x["reading"] = Object{"text": value, "permission": "current-source-read-only", "publicationPermission": false}
			}
			if reading := obj(o["reading"]); text(reading, "expiresAt") != "" {
				at, _ := time.Parse(time.RFC3339Nano, text(reading, "expiresAt"))
				if !at.After(time.Unix(s.now(), 0)) {
					return nil, fault.New("chat_message_version_unavailable", 409)
				}
			}
			sources = append(sources, x)
		}
		detailed := []any{}
		for _, v := range deps {
			d := obj(v)
			sourceRefs := []any{}
			for _, v := range resolved {
				o := obj(v)
				for _, v := range list(o["dependencies"]) {
					x := obj(v)
					if x["key"] == d["key"] && x["authorId"] == d["authorId"] {
						sourceRefs = append(sourceRefs, o["ref"])
						break
					}
				}
			}
			ids := covering[text(d, "key")]
			if ids == nil {
				ids = []any{}
			}
			detailed = append(detailed, Object{"key": d["key"], "authorId": d["authorId"], "covered": coverage[text(d, "key")] == text(d, "authorId"), "permissionIds": ids, "sourceRefs": sourceRefs})
		}
		out["sourceCoverage"] = Object{"sources": sources, "dependencies": detailed}
		out["uncovered"] = uncovered
	}
	return out, nil
}
