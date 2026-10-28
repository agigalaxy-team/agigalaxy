package capsules

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) caseSource(ctx context.Context, tx pgx.Tx, id, owner string) (Object, error) {
	if s.Cases == nil {
		return nil, fault.New("capsule_case_unavailable", 503)
	}
	c, e := s.Cases.CaseWithin(ctx, tx, id)
	if e != nil {
		if fault.Code(e) == "case_unavailable" {
			return nil, fault.New("capsule_case_unavailable", 403)
		}
		return nil, e
	}
	parent := obj(c["parent"])
	if parent["subject_id"] != owner || parent["state"] == "withdrawn" {
		return nil, fault.New("capsule_case_unavailable", 403)
	}
	rows := rowsOf(c["rows"])
	for _, row := range rows {
		if _, e = s.grant(ctx, tx, row, "case.teaser.publish"); e != nil {
			return nil, e
		}
	}
	pending := false
	for _, value := range cases.ProjectReviews(rows) {
		r := obj(value)
		pending = pending || (r["state"] != "resolved" && r["state"] != "rejected")
	}
	for _, row := range rows {
		if row["kind"] == "revision" && obj(row["payload"])["review"] == nil {
			pending = true
		}
	}
	return Object{"parent": parent, "rows": rows, "needsReview": pending}, nil
}
func (s *Service) legacyVersion(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id, versionID string) (*version, error) {
	hidden, e := s.hidden(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	if hidden {
		owner, e := one(ctx, tx, `SELECT subject_id FROM capsules WHERE id=$1`, id)
		if e != nil {
			return nil, e
		}
		if subject(a) != text(owner, "subject_id") {
			return nil, fault.New("capsule_unavailable", 404)
		}
	}
	var exact any
	if versionID != "" {
		exact = versionID
	}
	rows, e := query(ctx, tx, `SELECT * FROM capsule_events WHERE capsule_id=$1 AND kind='version' AND ($2::uuid IS NULL OR id=$2) ORDER BY revision DESC`, id, exact)
	if e != nil {
		return nil, e
	}
	if len(rows) > 0 && text(rows[0], "payload_text") != "" {
		raw, e := parseStored(rows[0])
		if e != nil {
			return nil, e
		}
		if number(raw.Values(), "schemaVersion") == 2 {
			return nil, fault.New("unsupported_semantics", 409)
		}
	}
	for _, row := range rows {
		v, e := func() (*version, error) {
			g, e := s.grant(ctx, tx, row, "capsule.publish")
			if e != nil {
				return nil, e
			}
			if !s.visible(g, a) {
				return nil, nil
			}
			wire, e := parseStored(row)
			if e != nil {
				return nil, e
			}
			p := wire.Values()
			source, e := s.caseSource(ctx, tx, text(obj(p["sourceResolution"]), "caseId"), text(row, "subject_id"))
			if e != nil {
				return nil, e
			}
			m, e := s.maintenance(ctx, tx, a, id, text(row, "id"), true)
			if e != nil {
				return nil, e
			}
			return &version{row: row, payload: p, wire: wire, grant: g, source: source, deprecated: m["deprecated"] == true, security: m["securityIssue"] == true, notices: list(m["notices"])}, nil
		}()
		if e != nil {
			if serviceError(e) {
				continue
			}
			return nil, e
		}
		if v != nil {
			return v, nil
		}
	}
	return nil, fault.New("capsule_unavailable", 404)
}
func (s *Service) readLegacyWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	current, e := s.legacyVersion(ctx, tx, a, text(input, "capsuleId"), text(input, "versionId"))
	if e != nil {
		return nil, e
	}
	parent, e := one(ctx, tx, `SELECT * FROM capsules WHERE id=$1`, input["capsuleId"])
	if e != nil {
		return nil, e
	}
	rows, e := query(ctx, tx, `SELECT * FROM capsule_events WHERE capsule_id=$1 AND kind='version' ORDER BY revision`, parent["id"])
	if e != nil {
		return nil, e
	}
	versions := []any{}
	for _, row := range rows {
		g, e := s.grant(ctx, tx, row, "capsule.publish")
		if e != nil {
			if serviceError(e) {
				continue
			}
			return nil, e
		}
		if s.visible(g, a) {
			p, e := parseStored(row)
			if e != nil {
				return nil, e
			}
			versions = append(versions, Object{"versionId": row["id"], "version": p.Values()["version"], "title": p.Values()["title"]})
		}
	}
	resolution := obj(current.payload["sourceResolution"])
	proofs, e := s.proofReferences(ctx, tx, a, list(resolution["proofIds"]), text(resolution, "caseId"), text(resolution, "resultId"), false)
	if e != nil {
		return nil, e
	}
	revision := number(current.row, "revision")
	for _, v := range current.notices {
		if n := number(obj(v), "revision"); n > revision {
			revision = n
		}
	}
	if subject(a) == text(parent, "subject_id") {
		revision = number(parent, "revision")
	}
	out := Object{"capsuleId": parent["id"], "authorId": parent["subject_id"], "revision": revision, "versionId": current.row["id"], "version": current.wire, "versions": versions, "notices": current.notices, "deprecated": current.deprecated, "securityIssue": current.security, "sourceNeedsReview": current.source["needsReview"], "sourceProofs": proofs, "capabilityVerified": false, "contributorsAuthority": "author-declared attribution; not contributor approval"}
	if subject(a) == text(parent, "subject_id") {
		out["nextVersion"] = len(rows) + 1
		out["disclosure"] = Object{"visibility": current.grant.Visibility, "viewers": current.grant.Viewers}
	}
	return out, nil
}
func (s *Service) Get(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parseInput(raw, "read")
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.readLegacyWithin(ctx, tx, a, input)
	})
}

// ReadWithin is the original authorized-view export consumer. The caller owns
// its already authorized transaction; each Capsule/source Consent is rechecked.
func (s *Service) ReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	return s.readLegacyWithin(ctx, tx, a, input)
}
