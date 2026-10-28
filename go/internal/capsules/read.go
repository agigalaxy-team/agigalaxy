package capsules

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	textcases "golang.org/x/text/cases"
	"golang.org/x/text/language"
	"strings"
	"time"
)

func lower(s string) string { return textcases.Lower(language.Und).String(s) }

func ownControl(a *deviceauth.Actor, row Object, kind string) any {
	if subject(a) != text(row, "subject_id") {
		return nil
	}
	return Object{"type": kind, "operationId": row["id"], "consentId": row["consent_id"], "payloadHash": row["payload_hash"]}
}
func (s *Service) ReadV2Within(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	v, e := s.versionWithin(ctx, tx, a, text(input, "capsuleId"), text(input, "versionId"), true, false)
	if e != nil {
		return nil, e
	}
	var own Object
	if a != nil {
		own, e = one(ctx, tx, `SELECT revision FROM capsules WHERE id=$1 AND subject_id=$2`, input["capsuleId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
	}
	out := Object{"capsuleId": input["capsuleId"], "versionId": v.row["id"]}
	if control := ownControl(a, v.row, "publication"); control != nil {
		out["ownerControl"] = control
	}
	if v.status == "source-unavailable" {
		out["version"] = nil
		out["sourceStatus"] = v.status
		out["reason"] = v.source["reason"]
		if own != nil {
			out["authorId"] = v.row["subject_id"]
			out["revision"] = own["revision"]
		}
		out["deprecated"] = v.deprecated
		out["securityIssue"] = v.security
		out["notices"] = v.notices
		out["newApplicationAllowed"] = false
		out["capabilityVerified"] = false
		return out, nil
	}
	out["authorId"] = v.row["subject_id"]
	out["version"] = v.wire
	if own != nil {
		out["revision"] = own["revision"]
	}
	out["sourceStatus"] = v.status
	out["permissions"] = v.source["permissions"]
	attrs, e := s.attributions(ctx, tx, a, list(v.source["attributions"]))
	if e != nil {
		return nil, e
	}
	out["attributions"] = attrs
	if number(v.payload, "schemaVersion") == 2 {
		reading, e := s.resolutionReading(ctx, tx, a, obj(v.payload["sourceResolution"]))
		if e != nil {
			return nil, e
		}
		out["sourceReading"] = reading
	}
	out["deprecated"] = v.deprecated
	out["securityIssue"] = v.security
	out["notices"] = v.notices
	out["newApplicationAllowed"] = !v.deprecated && !v.security && v.source["sourceCurrent"] == true
	out["synthetic"] = v.source["synthetic"]
	out["compatibility"] = v.compatibility
	out["readingIsReuse"] = false
	out["coauthorApproval"] = false
	out["capabilityVerified"] = false
	return out, nil
}
func (s *Service) GetV2(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "read")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadV2Within(ctx, tx, a, p)
	})
}
func (s *Service) QueryV2(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "query")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		items := []any{}
		var cursor any
		for {
			rows, e := query(ctx, tx, `SELECT id FROM capsules WHERE ($1::text IS NULL OR subject_id=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`, p["authorId"], cursor)
			if e != nil {
				return nil, e
			}
			for _, row := range rows {
				item, e := s.ReadV2Within(ctx, tx, a, Object{"capsuleId": row["id"]})
				if e != nil {
					if absent(e) {
						continue
					}
					return nil, e
				}
				v := obj(item["version"])
				if v == nil || p["capabilityId"] != nil && v["capabilityId"] != p["capabilityId"] || !strings.Contains(lower(text(v, "title")+" "+text(v, "problemPattern")), lower(text(p, "query"))) {
					continue
				}
				record := Object{"capsuleId": row["id"], "versionId": item["versionId"], "sourceVersion": v["version"], "authorId": item["authorId"], "title": v["title"], "problemPattern": v["problemPattern"], "capabilityId": v["capabilityId"], "sourceStatus": item["sourceStatus"], "deprecated": item["deprecated"], "securityIssue": item["securityIssue"], "newApplicationAllowed": item["newApplicationAllowed"], "capabilityVerified": false}
				for _, key := range []string{"publicationClass", "synthetic"} {
					if value, present := v[key]; present {
						record[key] = value
					}
				}
				items = append(items, record)
			}
			if len(rows) < 100 {
				break
			}
			cursor = rows[len(rows)-1]["id"]
		}
		return page(items, "capsuleId", p, Object{"coverage": "visible-page-only", "windowLimited": false}), nil
	})
}
func orderedFields(o Object, keys ...string) *protocol.OrderedObject {
	out := protocol.NewOrderedObject()
	for _, k := range keys {
		if v, ok := o[k]; ok {
			out.Set(k, v)
		}
	}
	return out
}
func page(items []any, key string, p, extra Object) Object {
	remaining := []any{}
	for _, v := range items {
		if after := text(p, "after"); after == "" || text(obj(v), key) > after {
			remaining = append(remaining, v)
		}
	}
	limit := int(number(p, "limit"))
	out := extra
	if out == nil {
		out = Object{}
	}
	out["nextAfter"] = nil
	if len(remaining) > limit {
		out["nextAfter"] = obj(remaining[limit-1])[key]
		remaining = remaining[:limit]
	}
	out["items"] = remaining
	return out
}

// QueryV2Wire retains the exact query-record order used by SearchV2 fingerprints.
func (s *Service) QueryV2Wire(ctx context.Context, a *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
	o, e := s.QueryV2(ctx, a, raw)
	if e != nil {
		return nil, e
	}
	items := []any{}
	for _, v := range list(o["items"]) {
		items = append(items, orderedFields(obj(v), "capsuleId", "versionId", "sourceVersion", "authorId", "publicationClass", "synthetic", "title", "problemPattern", "capabilityId", "sourceStatus", "deprecated", "securityIssue", "newApplicationAllowed", "capabilityVerified"))
	}
	o["items"] = items
	b, e := protocol.EncodeJS(orderedFields(o, "items", "nextAfter", "coverage", "windowLimited"))
	return json.RawMessage(b), e
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "receipt")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		var row Object
		var e error
		switch p["type"] {
		case "publication":
			row, e = one(ctx, tx, `SELECT id,capsule_id,version_id,revision,consent_id,payload_hash FROM capsule_events WHERE id=$1 AND subject_id=$2`, p["operationId"], a.SubjectID)
		case "use":
			row, e = one(ctx, tx, `SELECT id,capsule_id,version_id,kind,consent_id,payload_hash FROM capsule_uses_v2 WHERE id=$1 AND subject_id=$2`, p["operationId"], a.SubjectID)
		case "permission":
			row, e = one(ctx, tx, `SELECT id AS permission_id,CASE WHEN id=$1 THEN consent_id ELSE revoke_consent_id END AS consent_id,CASE WHEN id=$1 THEN payload_hash ELSE revoke_payload_hash END AS payload_hash FROM capsule_permissions WHERE subject_id=$2 AND(id=$1 OR revoke_id=$1)`, p["operationId"], a.SubjectID)
		}
		if e != nil {
			return nil, e
		}
		out := Object{"state": "absent", "operationId": p["operationId"], "currentReadPermissionConfirmed": false}
		if row == nil {
			return out, nil
		}
		if row["payload_hash"] != p["payloadHash"] {
			out["state"] = "conflict"
			return out, nil
		}
		out["state"] = "acknowledged"
		out["consentId"] = row["consent_id"]
		if row["capsule_id"] != nil {
			out["capsuleId"] = row["capsule_id"]
			out["versionId"] = row["version_id"]
		}
		if row["permission_id"] != nil {
			out["permissionId"] = row["permission_id"]
		}
		if number(row, "revision") != 0 {
			out["revision"] = row["revision"]
		}
		return out, nil
	})
}
func (s *Service) Versions(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "versions")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, `SELECT id,subject_id FROM capsule_events WHERE capsule_id=$1 AND kind='version' ORDER BY id`, p["capsuleId"])
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, row := range rows {
			v, e := s.versionWithin(ctx, tx, a, text(p, "capsuleId"), text(row, "id"), true, false)
			if e != nil {
				if absent(e) {
					continue
				}
				return nil, e
			}
			var title any = v.payload["title"]
			if v.status == "source-unavailable" {
				title = nil
			}
			o := Object{"versionId": row["id"], "version": v.payload["version"], "title": title, "sourceStatus": v.status, "deprecated": v.deprecated, "securityIssue": v.security}
			if own := ownControl(a, v.row, "publication"); own != nil {
				o["ownerControl"] = own
			}
			if subject(a) == text(row, "subject_id") {
				o["disclosure"] = Object{"visibility": v.grant.Visibility, "viewers": v.grant.Viewers}
			}
			items = append(items, o)
		}
		out := page(items, "versionId", p, Object{"capsuleId": p["capsuleId"], "coverage": "currently-authorized-versions; no-latest-fallback"})
		if a != nil {
			parent, e := one(ctx, tx, `SELECT revision FROM capsules WHERE id=$1 AND subject_id=$2`, p["capsuleId"], a.SubjectID)
			if e != nil {
				return nil, e
			}
			if parent != nil {
				out["management"] = Object{"revision": parent["revision"], "publishedVersionCount": len(rows)}
			}
		}
		return out, nil
	})
}
func (s *Service) GetPermission(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "permission-read")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		r, e := s.permissionWithin(ctx, tx, &a, text(p, "permissionId"), true)
		if e != nil {
			return nil, e
		}
		return Object{"permissionId": p["permissionId"], "authorId": r.row["subject_id"], "payload": r.wire, "revoked": r.row["revoked_at"] != nil, "coauthorApproval": false, "externalRightsVerified": false}, nil
	})
}
func (s *Service) Permissions(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "permissions")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, `SELECT p.id FROM capsule_permissions p JOIN consents c ON c.id=p.consent_id WHERE p.payload_text<>'' AND($2='owned' AND p.subject_id=$1 OR $2='granted' AND p.subject_id<>$1 AND(c.intent->'viewers' ? $1 OR c.intent->>'visibility'='Public')) ORDER BY p.id`, a.SubjectID, p["view"])
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, row := range rows {
			r, e := s.permissionWithin(ctx, tx, &a, text(row, "id"), true)
			if e != nil {
				if absent(e) {
					continue
				}
				return nil, e
			}
			if p["view"] == "granted" {
				found := false
				for _, v := range list(r.payload["grantees"]) {
					found = found || v == a.SubjectID
				}
				if !found {
					continue
				}
			}
			status := "current"
			grantor := deviceauth.Actor{SubjectID: text(r.row, "subject_id")}
			for _, v := range list(r.payload["sources"]) {
				if _, e := s.SourceWithin(ctx, tx, &grantor, obj(v), false, nil); e != nil {
					if !absent(e) {
						return nil, e
					}
					status = "source-unavailable"
					break
				}
			}
			expired := false
			if exp := text(r.payload, "expiresAt"); exp != "" {
				at, _ := time.Parse(time.RFC3339Nano, exp)
				expired = !at.After(time.Unix(s.now(), 0))
			}
			items = append(items, Object{"permissionId": row["id"], "authorId": r.row["subject_id"], "payload": r.wire, "revoked": r.row["revoked_at"] != nil, "expired": expired, "sourceStatus": status, "coauthorApproval": false, "externalRightsVerified": false})
		}
		return page(items, "permissionId", p, Object{"coverage": "currently-authorized-explicit-permissions"}), nil
	})
}
func (s *Service) Preview(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseInput(raw, "preview")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		payload := obj(p["payload"])
		sources, e := s.publicationSources(ctx, tx, &a, payload, text(p, "visibility"), true, true)
		if e != nil {
			if !absent(e) {
				return nil, e
			}
			return Object{"readyForPublication": false, "visibility": p["visibility"], "readyForPublicPublication": false, "published": false, "draftStorage": "user-side-only", "reason": fault.Code(e), "capabilityVerified": false, "automaticPublication": false}, nil
		}
		attrs, e := s.attributions(ctx, tx, &a, list(sources["attributions"]))
		if e != nil {
			return nil, e
		}
		for _, v := range list(obj(sources["sourceCoverage"])["sources"]) {
			reading := obj(obj(v)["reading"])
			if exp := text(reading, "expiresAt"); exp != "" {
				at, _ := time.Parse(time.RFC3339Nano, exp)
				if !at.After(time.Unix(s.now(), 0)) {
					return Object{"readyForPublication": false, "visibility": p["visibility"], "readyForPublicPublication": false, "published": false, "draftStorage": "user-side-only", "reason": "chat_message_version_unavailable", "capabilityVerified": false, "automaticPublication": false}, nil
				}
			}
		}
		ready := len(list(sources["uncovered"])) == 0
		out := Object{"readyForPublication": ready, "visibility": p["visibility"], "readyForPublicPublication": ready && p["visibility"] == "Public", "sourceCoverage": sources["sourceCoverage"], "published": false, "draftStorage": "user-side-only", "payload": p["payload"], "permissions": sources["permissions"], "attributions": attrs, "capabilityVerified": false, "requiredFinalStep": "exact publication Consent with chosen visibility", "coauthorApproval": false}
		if !ready {
			out["reason"] = "capsule_source_permission_required"
		}
		return out, nil
	})
}
