package configurations

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/jackc/pgx/v5"
)

func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	p, e := parseRequest(encode(input), "read")
	if e != nil {
		return nil, e
	}
	parent, e := one(ctx, tx, `SELECT id::text,subject_id,version,state FROM configuration_objects WHERE id=$1 FOR SHARE`, p["id"])
	if e != nil {
		return nil, e
	}
	if parent == nil {
		return nil, fault.New("configuration_unavailable", 404)
	}
	version := number(parent, "version")
	if _, ok := p["version"]; ok {
		version = number(p, "version")
	}
	row, e := one(ctx, tx, `SELECT operation_id::text,subject_id,version,kind,consent_id::text,payload_text,payload_hash FROM configuration_events WHERE configuration_id=$1 AND version=$2`, p["id"], version)
	if e != nil {
		return nil, e
	}
	if row == nil || text(row, "payload_text") == "" {
		return nil, fault.New("configuration_source_erased", 404)
	}
	payload := text(row, "payload_text")
	if identity.Digest([]byte(payload)) != row["payload_hash"] {
		return nil, fault.New("configuration_integrity_mismatch", 500)
	}
	if s.Devices == nil {
		return nil, fault.New("configuration_unavailable", 503)
	}
	grant, e := s.Devices.RequireConsentWithin(ctx, tx, deviceauth.ConsentRequirement{ID: text(row, "consent_id"), SubjectID: text(row, "subject_id"), Action: "configuration.publish", ObjectID: text(row, "operation_id"), Recipient: s.Endpoint, PayloadJSON: payload})
	if e != nil {
		return nil, e
	}
	if !s.visible(grant, a) {
		return nil, fault.New("configuration_authorization_unavailable", 403)
	}
	record, e := parseEvent(payload)
	if e != nil {
		return nil, e
	}
	revoked := parent["state"] == "revoked" || record.Values()["kind"] == "revoke"
	status := "historical-version"
	if revoked {
		status = "revoked"
	} else if version == number(parent, "version") {
		status = "current"
	}
	var content any = record
	if revoked {
		content = nil
	}
	out := Object{"id": parent["id"], "version": row["version"], "subjectId": row["subject_id"], "sourceStatus": status, "record": content, "contentAvailable": !revoked, "actualInstallationVerified": false, "unknownFieldsMeaning": "not-disclosed-or-not-known; no-equivalence-inferred"}
	if s.grantAuthor != "" && s.grantAuthor == parent["subject_id"] || s.grantAuthor == "" && a != nil && a.SubjectID == parent["subject_id"] {
		out["management"] = build("version", parent["version"], "state", parent["state"])
		out["disclosure"] = build("visibility", grant.Visibility, "viewers", grant.Viewers)
	}
	return out, nil
}
func (s *Service) ConditionWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref any) (Object, error) {
	if ref == nil {
		return Object{"reference": nil, "sourceStatus": "not-recorded", "record": nil, "conditionsKnown": false}, nil
	}
	r := obj(ref)
	reference := build("id", r["id"], "version", r["version"])
	value, e := s.ReadWithin(ctx, tx, a, Object{"id": r["id"], "version": r["version"]})
	if e != nil {
		if !missing(e) {
			return nil, e
		}
		return Object{"reference": reference, "sourceStatus": "unavailable", "record": nil, "conditionsKnown": false, "meaning": "conditions-unknown; existing-work-is-not-erased"}, nil
	}
	value["reference"] = reference
	value["conditionsKnown"] = value["record"] != nil
	value["meaning"] = "reported-conditions; not-authorization-to-republish"
	return value, nil
}
func (s *Service) RequireReferenceWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ref Object) (Object, error) {
	v, e := s.ReadWithin(ctx, tx, a, Object{"id": ref["id"], "version": ref["version"]})
	if e != nil {
		return nil, e
	}
	if v["record"] == nil || v["contentAvailable"] != true {
		return nil, fault.New("configuration_content_unavailable", 403)
	}
	return v, nil
}
func (s *Service) managedWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, p Object) (Object, error) {
	v, e := s.ReadWithin(ctx, tx, a, p)
	if e == nil {
		return v, nil
	}
	if !missing(e) || a == nil || a.SubjectID == "" {
		return nil, e
	}
	parent, err := one(ctx, tx, `SELECT id::text,version,state FROM configuration_objects WHERE id=$1 AND subject_id=$2`, p["id"], a.SubjectID)
	if err != nil {
		return nil, err
	}
	if parent == nil {
		return nil, e
	}
	version := parent["version"]
	if v, ok := p["version"]; ok {
		version = v
	}
	return Object{"id": parent["id"], "version": version, "subjectId": a.SubjectID, "sourceStatus": "source-unavailable", "contentAvailable": false, "record": nil, "management": build("version", parent["version"], "state", parent["state"]), "actualInstallationVerified": false}, nil
}
func (s *Service) Get(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseRequest(raw, "read")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		if a == nil {
			return s.ReadWithin(ctx, tx, nil, p)
		}
		return s.managedWithin(ctx, tx, a, p)
	})
}
func (s *Service) Query(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseRequest(raw, "query")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, `SELECT id::text FROM configuration_objects WHERE ($1::text IS NULL OR subject_id=$1) ORDER BY id`, p["subjectId"])
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, r := range rows {
			v, e := s.managedWithin(ctx, tx, a, Object{"id": r["id"]})
			if e != nil {
				if missing(e) {
					continue
				}
				return nil, e
			}
			if (v["record"] != nil || v["management"] != nil) && (p["after"] == nil || text(v, "id") > text(p, "after")) {
				items = append(items, v)
			}
		}
		limit := int(number(p, "limit"))
		var next any
		if len(items) > limit {
			items = items[:limit]
			next = obj(items[len(items)-1])["id"]
		}
		return Object{"items": items, "nextAfter": next, "coverage": "currently-authorized-configurations"}, nil
	})
}
func (s *Service) Versions(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseRequest(raw, "versions")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, `SELECT version FROM configuration_events WHERE configuration_id=$1 AND version>$2 ORDER BY version`, p["id"], number(p, "afterVersion"))
		if e != nil {
			return nil, e
		}
		items := []any{}
		for _, r := range rows {
			v, e := s.ReadWithin(ctx, tx, a, Object{"id": p["id"], "version": r["version"]})
			if e != nil {
				if missing(e) {
					continue
				}
				return nil, e
			}
			items = append(items, v)
		}
		limit := int(number(p, "limit"))
		var next any
		if len(items) > limit {
			items = items[:limit]
			next = obj(items[len(items)-1])["version"]
		}
		return Object{"id": p["id"], "items": items, "nextAfterVersion": next}, nil
	})
}
func (s *Service) Receipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	p, e := parseRequest(raw, "receipt")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		r, e := one(ctx, tx, `SELECT configuration_id::text,version,payload_hash,consent_id::text FROM configuration_events WHERE operation_id=$1 AND subject_id=$2`, p["operationId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		state := "absent"
		if r != nil {
			state = "conflict"
			if r["payload_hash"] == p["payloadHash"] {
				state = "acknowledged"
			}
		}
		out := Object{"operationId": p["operationId"], "state": state, "currentReadPermissionConfirmed": false}
		if state == "acknowledged" {
			out["id"] = r["configuration_id"]
			out["version"] = r["version"]
			out["consentId"] = r["consent_id"]
		}
		return out, nil
	})
}
