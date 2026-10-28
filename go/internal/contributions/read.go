package contributions

import (
	"context"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) Status(ctx context.Context, a Actor, input Object) (any, error) {
	if !closed(input, []string{"publicationId"}, nil) || !uuidPattern.MatchString(str(input, "publicationId")) {
		return nil, fail("invalid_contribution_reference", 400)
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		current, e := row(ctx, tx, "SELECT to_jsonb(p) FROM contribution_publications p WHERE id=$1 AND subject_id=$2", input["publicationId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if current == nil {
			return Object{"publicationId": input["publicationId"], "state": "absent"}, nil
		}
		state := "published"
		if current["revoked_at"] != nil {
			state = "revoked"
		}
		unavailable := 0
		var payload Object
		if str(current, "payload_text") != "" {
			payload, e = ParsePublication([]byte(str(current, "payload_text")))
			if e != nil {
				return nil, e
			}
		}
		if payload == nil {
			state = "source-unavailable"
		} else if state != "revoked" {
			expiry, _ := date(payload["expiresAt"])
			if expiry.UnixMilli() <= s.now()*1000 {
				state = "expired"
			}
			grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: str(current, "consent_id"), SubjectID: a.SubjectID, ObjectID: str(current, "id"), Action: "contribution.publish", Recipient: s.Endpoint, PayloadJSON: str(current, "payload_text")})
			if e != nil {
				if !absent(e) {
					return nil, e
				}
				state = "authorization-unavailable"
			} else if grant.CurrentVisibility != nil && grant.CurrentVisibility.DeletionPending {
				state = "source-unavailable"
			}
			for _, v := range array(payload["sourceRefs"]) {
				ref := object(v)
				source, e := s.SourceWithin(ctx, tx, ref)
				if e == nil {
					_, e = s.SourceGrantWithin(ctx, tx, str(ref, "kind"), source)
				}
				if e != nil {
					if !absent(e) {
						return nil, e
					}
					unavailable++
				}
			}
			if unavailable > 0 && state == "published" {
				state = "source-unavailable"
			}
		}
		refs, purposes := payload["sourceRefs"], payload["purposes"]
		if refs == nil {
			refs = []any{}
		}
		if purposes == nil {
			purposes = []any{}
		}
		return Object{"publicationId": current["id"], "state": state, "payloadHash": current["payload_hash"], "sourceRefs": refs, "purposes": purposes, "expiresAt": payload["expiresAt"], "revokeOperationId": current["revoke_id"], "revokePayloadHash": current["revoke_payload_hash"], "sourceUnavailable": unavailable, "originalPermissionsChanged": false}, nil
	})
}
func (s *Service) OwnedSources(ctx context.Context, a Actor, input Object) (any, error) {
	if !closed(input, []string{"kind", "parentId"}, []string{"after", "limit"}) || !uuidPattern.MatchString(str(input, "parentId")) {
		return nil, fail("invalid_contribution_source_query", 400)
	}
	table, parent, _, e := tableInfo(str(input, "kind"))
	if e != nil {
		return nil, fail("invalid_contribution_source_query", 400)
	}
	var after any
	if v, ok := input["after"]; ok {
		if !uuidPattern.MatchString(text(v)) {
			return nil, fail("invalid_contribution_source_query", 400)
		}
		after = v
	}
	limit := int64(30)
	if v, ok := input["limit"]; ok {
		if !integer(v, 1, 100) {
			return nil, fail("invalid_contribution_source_query", 400)
		}
		limit = number(v)
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		candidates, e := rows(ctx, tx, "SELECT to_jsonb(e) FROM "+table+" e WHERE "+parent+"=$1 AND subject_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", input["parentId"], a.SubjectID, after, limit+1)
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, r := range candidates[:min(len(candidates), int(limit))] {
			ref := Object{"kind": input["kind"], "id": r["id"], "eventVersion": 1, "payloadHash": r["payload_hash"]}
			current, e := s.SourceWithin(ctx, tx, ref)
			if e == nil {
				_, e = s.SourceGrantWithin(ctx, tx, str(input, "kind"), current)
			}
			if e != nil {
				if !absent(e) {
					return nil, e
				}
				continue
			}
			items = append(items, Object{"source": ref, "eventType": current["kind"], "availableFields": append([]string{}, ProjectionFields...), "publication": "not-published-by-enumeration"})
		}
		var next any
		if int64(len(candidates)) > limit {
			next = candidates[limit-1]["id"]
		}
		return Object{"items": items, "nextAfter": next, "coverage": "current-own-publishable-events-only", "originalTextIncluded": false}, nil
	})
}
func (s *Service) Preview(ctx context.Context, a Actor, input Object) (any, error) {
	if !closed(input, []string{"sourceRefs", "purposes"}, nil) || !parseRefsAndPurposes(input) {
		return nil, fail("invalid_contribution_preview", 400)
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		items := []any{}
		for _, v := range array(input["sourceRefs"]) {
			ref := object(v)
			current, e := s.SourceWithin(ctx, tx, ref)
			if e != nil {
				return nil, e
			}
			if _, e = s.SourceGrantWithin(ctx, tx, str(ref, "kind"), current); e != nil {
				return nil, e
			}
			if current["subject_id"] != a.SubjectID {
				return nil, fail("contribution_source_author_required")
			}
			source := Object{}
			for k, v := range ref {
				if k != "fields" {
					source[k] = v
				}
			}
			projection, e := s.ProjectWithin(ctx, tx, &a.Actor, current, stringsIn(ref["fields"]), Permission{})
			if e != nil {
				return nil, e
			}
			items = append(items, Object{"ref": source, "projection": projection, "publication": "not-published-by-preview"})
		}
		return Object{"items": items, "purposes": input["purposes"], "publicationScope": PublicationScope, "originalPermissionsChanged": false, "derivedDisclosure": "The selected purposes may attribute and count this author’s currently valid scoped contribution; no unselected text or other-party identity is disclosed."}, nil
	})
}
func (s *Service) ReadProjection(ctx context.Context, a *Actor, input Object) (any, error) {
	valid := closed(input, []string{"source", "purpose"}, nil) && sourceRef(object(input["source"]), false) || closed(input, []string{"publicationId", "sourceKey", "purpose"}, nil) && uuidPattern.MatchString(str(input, "publicationId")) && hashPattern.MatchString(str(input, "sourceKey"))
	if !valid || !has([]string{"honor", "requester-history"}, str(input, "purpose")) {
		return nil, fail("invalid_contribution_reference", 400)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (any, error) {
		ref := object(input["source"])
		if ref == nil {
			publication, e := row(ctx, tx, "SELECT jsonb_build_object('payload_text',payload_text) FROM contribution_publications WHERE id=$1", input["publicationId"])
			if e != nil {
				return nil, e
			}
			if publication == nil || str(publication, "payload_text") == "" {
				return nil, fail("contribution_source_unavailable", 404)
			}
			p, e := ParsePublication([]byte(str(publication, "payload_text")))
			if e != nil {
				return nil, e
			}
			if p["kind"] == "publish" {
				for _, v := range array(p["sourceRefs"]) {
					r := object(v)
					raw, _ := protocol.EncodeJS([]any{r["kind"], r["id"], r["payloadHash"]})
					if identity.Digest(raw) == input["sourceKey"] {
						ref = Object{}
						for k, v := range r {
							if k != "fields" {
								ref[k] = v
							}
						}
						break
					}
				}
			}
			if ref == nil {
				return nil, fail("contribution_source_unavailable", 404)
			}
		}
		current, e := s.SourceWithin(ctx, tx, ref)
		if e != nil {
			return nil, e
		}
		var actor *deviceauth.Actor
		if a != nil {
			actor = &a.Actor
		}
		permission, e := s.AuthorizeWithin(ctx, tx, actor, str(ref, "kind"), current, str(input, "purpose"))
		if e != nil {
			return nil, e
		}
		projection, e := s.ProjectWithin(ctx, tx, actor, current, permission.Fields, permission)
		if e != nil {
			return nil, e
		}
		return Object{"ref": s.Reference(current, str(ref, "kind"), permission), "projection": projection, "publicationIds": permission.PublicationIDs, "sourceState": "currently-authorized-projection", "originalTextAccessGranted": false, "capabilityVerified": false}, nil
	})
}
