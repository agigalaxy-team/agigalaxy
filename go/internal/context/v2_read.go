package contextdata

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

func visible(state string) bool { return state == "pending" || state == "accepted" }

type inspectedV2 struct {
	row, payload, acceptance Object
	state                    string
}

func (s *Service) locateV2(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string, lock bool) (Object, error) {
	sql := `SELECT ` + grantColumns + ` FROM context_grants_v2 WHERE id=$1 AND (subject_id=$2 OR participant_id=$2)`
	if lock {
		sql += ` FOR UPDATE`
	}
	r, e := row(ctx, tx, sql, id, a.SubjectID)
	if e != nil {
		return nil, e
	}
	if r == nil {
		return nil, fault.New("not_found", 404)
	}
	return r, nil
}
func expired(r Object, now int64) bool {
	at, _ := r["expires_at"].(time.Time)
	return !at.After(time.Unix(now, 0))
}
func (s *Service) inspectV2(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string) (inspectedV2, error) {
	bad := func(e error) (inspectedV2, error) { return inspectedV2{}, e }
	candidate, e := s.locateV2(ctx, tx, a, id, false)
	if e != nil {
		return bad(e)
	}
	state := text(candidate, "state")
	sourceState := func(r Object) string {
		if r["erased_at"] != nil || text(r, "payload_text") == "" {
			return "source-erased"
		}
		if r["revoked_at"] != nil {
			return "revoked"
		}
		if expired(r, s.now()) {
			return "expired"
		}
		return ""
	}
	if current := sourceState(candidate); current != "" {
		state = current
	}
	var payload Object
	if visible(state) {
		p, e := parseGrant(text(candidate, "payload_text"), true)
		if e != nil {
			return bad(e)
		}
		payload = p.Values()
		if _, e = s.participation(ctx, tx, a, payload); e != nil {
			if !withheld(e) {
				return bad(e)
			}
			if one(fault.Code(e), "context_scope_changed", "context_participation_inactive") {
				state = strings.ReplaceAll(strings.TrimPrefix(fault.Code(e), "context_"), "_", "-")
			} else {
				state = "participation-unavailable"
			}
		}
	}
	r, e := s.locateV2(ctx, tx, a, id, true)
	if e != nil {
		return bad(e)
	}
	if current := sourceState(r); current != "" {
		state = current
	} else if visible(state) {
		state = text(r, "state")
	}
	if visible(state) {
		g, e := s.consent(ctx, tx, text(r, "subject_id"), text(r, "consent_id"), id, text(r, "payload_text"))
		if e != nil {
			if !withheld(e) {
				return bad(e)
			}
			state = "source-permission-unavailable"
		} else if g.CurrentVisibility != nil && g.CurrentVisibility.DeletionPending && a.SubjectID != r["subject_id"] {
			state = "source-deletion-pending"
		}
	}
	var acceptance Object
	if visible(state) && r["state"] == "accepted" {
		acceptance, e = row(ctx, tx, `SELECT `+eventColumns+` FROM context_events_v2 WHERE id=$1`, r["response_event_id"])
		if e != nil {
			return bad(e)
		}
		if a.SubjectID != r["subject_id"] {
			if acceptance == nil || acceptance["kind"] != "accept" {
				state = "acceptance-permission-unavailable"
			} else if _, e = s.consent(ctx, tx, text(acceptance, "subject_id"), text(acceptance, "consent_id"), text(acceptance, "id"), text(acceptance, "payload_text")); e != nil {
				if !withheld(e) {
					return bad(e)
				}
				state = "acceptance-permission-unavailable"
			}
		}
	}
	if !visible(state) {
		payload = nil
	}
	return inspectedV2{r, payload, acceptance, state}, nil
}
func storedMetadata(r Object) Object {
	expires, _ := r["expires_at"].(time.Time)
	created, _ := r["created_at"].(time.Time)
	return Object{"schemaVersion": 2, "grantId": r["id"], "taskId": r["task_id"], "participationId": r["participation_id"], "ownerId": r["subject_id"], "participantId": r["participant_id"], "scopeVersion": r["scope_version"], "scopeEventId": r["scope_event_id"], "materialsHash": r["materials_hash"], "expiresAt": expires.Unix(), "createdAt": created.Unix()}
}

// ReadV2Within is for a current-authorized transaction consumer. Content and
// explicit metadata/export reads retain the original per-read audit event.
func (s *Service) ReadV2Within(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id string, includeContent bool, auth deviceauth.ControlAuthorization, readKind, requestID string) (Object, error) {
	inspected, e := s.inspectV2(ctx, tx, a, id)
	if e != nil {
		return nil, e
	}
	r, p := inspected.row, inspected.payload
	canRead := visible(inspected.state) && (a.SubjectID == r["subject_id"] || inspected.state == "accepted")
	materials := []any{}
	for _, v := range list(p["materials"]) {
		m := obj(v)
		item := build("id", m["id"], "label", m["label"], "mediaType", m["mediaType"], "contentHash", identity.Digest([]byte(text(m, "content"))))
		if includeContent && canRead {
			item.Set("content", m["content"])
		}
		materials = append(materials, item)
	}
	if includeContent || readKind == "metadata" {
		action := "context.metadata.read"
		switch {
		case readKind == "export":
			action = "context.export.read"
		case readKind == "inspect":
			action = "context.export.inspect"
		case canRead && includeContent:
			action = "context.read"
		}
		consent := text(r, "consent_id")
		if a.SubjectID != r["subject_id"] && text(inspected.acceptance, "consent_id") != "" {
			consent = text(inspected.acceptance, "consent_id")
		}
		if e = s.auditRead(ctx, tx, a, auth, id, action, consent, requestID); e != nil {
			return nil, e
		}
	}
	return Object{"metadata": storedMetadata(r), "state": inspected.state, "materials": materials, "contextAccessGranted": includeContent && canRead, "capabilityVerified": false, "executionPermissionGranted": false, "roomMembershipGranted": false, "originalContentErased": r["erased_at"] != nil, "authority": "current-authorized-context-view"}, nil
}
func (s *Service) GetV2(ctx context.Context, a deviceauth.Actor, id string, metadataOnly bool, requestID string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		kind := "direct"
		if metadataOnly {
			kind = "metadata"
		}
		return s.ReadV2Within(ctx, tx, a, id, !metadataOnly, auth, kind, requestID)
	})
}
func (s *Service) QueryV2(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	p, e := parseQuery(raw, "query", true)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, `SELECT id::text FROM context_grants_v2 WHERE task_id=$1 AND (subject_id=$2 OR participant_id=$2) AND ($3::uuid IS NULL OR participation_id=$3) AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`, p["taskId"], a.SubjectID, p["participationId"], p["after"], number(p, "limit")+1)
		if e != nil {
			return nil, e
		}
		limit := int(number(p, "limit"))
		more := len(rows) > limit
		if more {
			rows = rows[:limit]
		}
		items := []any{}
		for _, r := range rows {
			v, e := s.ReadV2Within(ctx, tx, a, text(r, "id"), false, deviceauth.ControlAuthorization{}, "direct", "")
			if e != nil {
				return nil, e
			}
			items = append(items, v)
		}
		if e = s.auditRead(ctx, tx, a, auth, text(p, "taskId"), "context.query", "", requestID); e != nil {
			return nil, e
		}
		var next any
		if more {
			next = rows[len(rows)-1]["id"]
		}
		return Object{"items": items, "nextAfter": next}, nil
	})
}
func (s *Service) ReceiptV2(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseQuery(raw, "receipt", true)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		sql := `SELECT id::text,subject_id,consent_id::text,payload_hash,grant_id::text FROM context_events_v2 WHERE id=$1`
		if p["eventId"] == p["grantId"] {
			sql = `SELECT id::text,subject_id,consent_id::text,payload_hash,id::text AS grant_id FROM context_grants_v2 WHERE id=$1`
		}
		r, e := row(ctx, tx, sql, p["eventId"])
		if e != nil {
			return nil, e
		}
		if r["subject_id"] != a.SubjectID {
			r = nil
		}
		matched := r != nil && r["grant_id"] == p["grantId"] && r["payload_hash"] == p["payloadHash"]
		state := "absent"
		if r != nil {
			state = "conflict"
		}
		if matched {
			state = "acknowledged"
		}
		out := Object{}
		for k, v := range p {
			out[k] = v
		}
		out["state"], out["checkedAt"], out["authority"] = state, s.now(), "accepted-event-only; not-current-authorization"
		if matched {
			out["consentId"] = r["consent_id"]
		}
		return out, nil
	})
}
