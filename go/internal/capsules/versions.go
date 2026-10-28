package capsules

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
	"sort"
	"time"
)

type version struct {
	row, payload, source  Object
	wire                  *protocol.OrderedObject
	grant                 deviceauth.ConsentIntent
	deprecated, security  bool
	notices               []any
	status, compatibility string
}

func (s *Service) hidden(ctx context.Context, tx pgx.Tx, id string) (bool, error) {
	if s.OperationsVisibility != nil {
		return s.OperationsVisibility(ctx, tx, id)
	}
	var hidden bool
	e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM operations_content_visibility_v1 WHERE endpoint=$1 AND target_kind='method' AND target_id=$2 AND hidden_until>$3)`, s.Endpoint, id, time.Unix(s.now(), 0)).Scan(&hidden)
	return hidden, e
}
func (s *Service) maintenance(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, capsuleID, versionID string, legacy bool) (Object, error) {
	rows, e := query(ctx, tx, `SELECT * FROM capsule_events WHERE capsule_id=$1 AND version_id=$2 AND kind<>'version' ORDER BY revision`, capsuleID, versionID)
	if e != nil {
		return nil, e
	}
	deprecated, security := false, false
	notices := []any{}
	for _, row := range rows {
		switch row["kind"] {
		case "deprecate":
			deprecated = true
		case "security-issue":
			security = true
		case "resolve-security":
			security = false
		}
		if !legacy && text(row, "payload_text") == "" {
			continue
		}
		g, e := s.grant(ctx, tx, row, "capsule.publish")
		if e != nil {
			if legacy && serviceError(e) || !legacy && absent(e) {
				continue
			}
			return nil, e
		}
		if s.visible(g, a) {
			p, e := parseStored(row)
			if e != nil {
				return nil, e
			}
			if legacy {
				o := protocol.NewOrderedObject()
				o.Set("revision", row["revision"])
				for _, k := range p.Keys() {
					o.Set(k, p.Values()[k])
				}
				notices = append(notices, o)
			} else {
				notices = append(notices, p)
			}
		}
	}
	return Object{"deprecated": deprecated, "securityIssue": security, "notices": notices}, nil
}
func (s *Service) versionWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, capsuleID, versionID string, tolerate, ignoreOperations bool) (*version, error) {
	var exact any
	if versionID != "" {
		exact = versionID
	}
	rows, e := query(ctx, tx, `SELECT * FROM capsule_events WHERE capsule_id=$1 AND kind='version' AND ($2::uuid IS NULL OR id=$2) ORDER BY revision DESC`, capsuleID, exact)
	if e != nil {
		return nil, e
	}
	if len(rows) == 0 || text(rows[0], "payload_text") == "" {
		return nil, fault.New("capsule_unavailable", 404)
	}
	row := rows[0]
	hidden, e := s.hidden(ctx, tx, capsuleID)
	if e != nil {
		return nil, e
	}
	if hidden && !ignoreOperations && subject(a) != text(row, "subject_id") {
		return nil, fault.New("capsule_unavailable", 404)
	}
	g, e := s.grant(ctx, tx, row, "capsule.publish")
	if e != nil {
		return nil, e
	}
	if !s.visible(g, a) {
		return nil, fault.New("capsule_unavailable", 404)
	}
	wire, e := parseStored(row)
	if e != nil {
		return nil, e
	}
	p := wire.Values()
	if number(p, "schemaVersion") == 2 {
		wire, e = parsePayload(text(row, "payload_text"), "event", true)
		if e != nil {
			return nil, e
		}
		p = wire.Values()
	}
	m, e := s.maintenance(ctx, tx, a, capsuleID, text(row, "id"), false)
	if e != nil {
		return nil, e
	}
	v := &version{row: row, payload: p, wire: wire, grant: g, deprecated: m["deprecated"] == true, security: m["securityIssue"] == true, notices: list(m["notices"]), status: "current", compatibility: "native-v2"}
	if number(p, "schemaVersion") != 2 {
		legacy, e := s.readLegacyWithin(ctx, tx, a, Object{"capsuleId": capsuleID, "versionId": row["id"]})
		if e != nil {
			return nil, e
		}
		v.source = Object{"legacy": legacy, "sourceCurrent": legacy["sourceNeedsReview"] != true, "synthetic": nil, "permissions": []any{}, "attributions": []any{}, "capabilityVerified": false}
		v.status = "legacy-v1-source-policy"
		v.compatibility = "legacy-author-declared-attribution; no-retroactive-source-signatures"
		return v, nil
	}
	publisher := deviceauth.Actor{SubjectID: text(row, "subject_id")}
	v.source, e = s.publicationSources(ctx, tx, &publisher, p, g.Visibility, false, false)
	if e != nil {
		if !absent(e) || !tolerate {
			return nil, e
		}
		v.status = "source-unavailable"
		v.source = Object{"reason": fault.Code(e)}
	} else if v.source["sourceCurrent"] != true {
		v.status = "source-result-superseded"
		if v.source["sourceCurrentness"] == "unavailable" {
			v.status = "source-currentness-unavailable"
		}
	}
	return v, nil
}
func sameDisclosure(a, b deviceauth.ConsentIntent) bool {
	if a.Visibility != b.Visibility {
		return false
	}
	x := append([]string{}, a.Viewers...)
	y := append([]string{}, b.Viewers...)
	sort.Strings(x)
	sort.Strings(y)
	return string(encode(x)) == string(encode(y))
}
func (s *Service) proofReferences(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, ids []any, caseID, resultID string, required bool) ([]any, error) {
	proofs := []any{}
	for _, id := range ids {
		e := func() error {
			row, e := one(ctx, tx, `SELECT p.id FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id WHERE p.id=$1 AND e.case_id=$2 AND e.result_id=$3`, id, caseID, resultID)
			if e != nil {
				return e
			}
			if row == nil {
				return fault.New("capsule_proof_mismatch", 409)
			}
			if s.Proofs == nil {
				return fault.New("capsule_proof_unavailable", 503)
			}
			_, e = s.Proofs.ReadWithin(ctx, tx, a, id.(string), false)
			return e
		}()
		if e != nil {
			if !serviceError(e) || required {
				return nil, e
			}
			proofs = append(proofs, Object{"proofId": id, "state": "unavailable", "capabilityVerified": false})
			continue
		}
		proofs = append(proofs, Object{"proofId": id, "state": "current", "strength": "ci-execution-fact", "capabilityVerified": false})
	}
	return proofs, nil
}
func (s *Service) PublishV2(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	return s.publish(ctx, a, raw, requestID, true)
}
func (s *Service) Publish(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	return s.publish(ctx, a, raw, requestID, false)
}
func (s *Service) publish(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string, v2 bool) (Object, error) {
	in, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	wire, e := parsePayload(text(in, "payloadJson"), "event", v2)
	if e != nil {
		return nil, e
	}
	p := wire.Values()
	return s.run(ctx, &a, true, p["kind"] != "version", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		if p["kind"] == "version" && number(p, "expectedRevision") == 0 {
			if _, e := tx.Exec(ctx, `INSERT INTO capsules(id,subject_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, p["capsuleId"], a.SubjectID); e != nil {
				return nil, e
			}
		}
		parent, e := one(ctx, tx, `SELECT * FROM capsules WHERE id=$1 AND subject_id=$2 FOR UPDATE`, p["capsuleId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if parent == nil {
			return nil, fault.New("capsule_owner_required", 403)
		}
		g, e := s.grant(ctx, tx, Object{"id": p["id"], "subject_id": a.SubjectID, "consent_id": in["consentId"], "payload_text": in["payloadJson"]}, "capsule.publish")
		if e != nil {
			return nil, e
		}
		if g.Visibility != "Private" && g.Visibility != "Public" {
			return nil, fault.New("capsule_visibility_required", 403)
		}
		prior, e := one(ctx, tx, `SELECT * FROM capsule_events WHERE id=$1`, p["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["subject_id"] != a.SubjectID || prior["capsule_id"] != parent["id"] || prior["consent_id"] != in["consentId"] || prior["payload_hash"] != identity.Digest([]byte(text(in, "payloadJson"))) {
				return nil, fault.New("capsule_conflict", 409)
			}
			out := Object{"capsuleId": parent["id"], "eventId": p["id"], "revision": prior["revision"]}
			if v2 {
				out["versionId"] = prior["version_id"]
			}
			return out, nil
		}
		if !v2 {
			var upgraded bool
			if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM capsule_events WHERE capsule_id=$1 AND NULLIF(payload_text,'')::jsonb->>'schemaVersion'='2')`, parent["id"]).Scan(&upgraded); e != nil {
				return nil, e
			}
			if upgraded {
				return nil, fault.New("unsupported_semantics", 409)
			}
		}
		if number(parent, "revision") != number(p, "expectedRevision") || number(parent, "revision") >= 200 {
			return nil, fault.New("capsule_revision_conflict", 409)
		}
		versionID := text(p, "versionId")
		if p["kind"] == "version" {
			var count int64
			if e := tx.QueryRow(ctx, `SELECT count(*) FROM capsule_events WHERE capsule_id=$1 AND kind='version'`, parent["id"]).Scan(&count); e != nil {
				return nil, e
			}
			if number(p, "version") != count+1 {
				return nil, fault.New("capsule_version_conflict", 409)
			}
			resolution := obj(p["sourceResolution"])
			if v2 {
				if _, e := s.publicationSources(ctx, tx, &a, p, g.Visibility, true, false); e != nil {
					return nil, e
				}
			} else {
				source, e := s.caseSource(ctx, tx, text(resolution, "caseId"), a.SubjectID)
				if e != nil {
					return nil, e
				}
				var result Object
				for _, row := range rowsOf(source["rows"]) {
					if row["id"] == resolution["resultId"] && row["kind"] == "result" {
						result = row
						break
					}
				}
				if result == nil || obj(result["payload"])["outcome"] != "succeeded" || source["needsReview"] == true {
					return nil, fault.New("capsule_resolution_required", 409)
				}
				for _, v := range list(p["contributors"]) {
					var exists bool
					if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM subjects WHERE id=$1)`, v).Scan(&exists); e != nil {
						return nil, e
					}
					if !exists {
						return nil, fault.New("capsule_contributor_unknown", 409)
					}
				}
			}
			if _, e := s.proofReferences(ctx, tx, &a, list(resolution["proofIds"]), text(resolution, "caseId"), text(resolution, "resultId"), true); e != nil {
				return nil, e
			}
			versionID = text(p, "id")
		} else {
			var current *version
			var e error
			if v2 {
				current, e = s.versionWithin(ctx, tx, &a, text(parent, "id"), versionID, true, false)
			} else {
				current, e = s.legacyVersion(ctx, tx, &a, text(parent, "id"), versionID)
			}
			if e != nil {
				return nil, e
			}
			if !sameDisclosure(g, current.grant) {
				return nil, fault.New("capsule_notice_visibility_mismatch", 403)
			}
			if p["kind"] == "deprecate" && current.deprecated || p["kind"] == "security-issue" && current.security || p["kind"] == "resolve-security" && !current.security {
				return nil, fault.New("capsule_transition_denied", 409)
			}
			if replacement := text(p, "replacementVersionId"); replacement != "" {
				if replacement == versionID {
					return nil, fault.New("capsule_replacement_mismatch", 409)
				}
				if v2 {
					_, e = s.versionWithin(ctx, tx, &a, text(parent, "id"), replacement, true, false)
				} else {
					_, e = s.legacyVersion(ctx, tx, &a, text(parent, "id"), replacement)
				}
				if e != nil {
					return nil, e
				}
			}
		}
		revision := number(parent, "revision") + 1
		if _, e := tx.Exec(ctx, `INSERT INTO capsule_events(id,capsule_id,subject_id,revision,version_id,kind,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, p["id"], parent["id"], a.SubjectID, revision, versionID, p["kind"], in["consentId"], in["payloadJson"], identity.Digest([]byte(text(in, "payloadJson")))); e != nil {
			return nil, e
		}
		if _, e := tx.Exec(ctx, `UPDATE capsules SET revision=$2 WHERE id=$1`, parent["id"], revision); e != nil {
			return nil, e
		}
		if e := s.audit(ctx, tx, a, auth, text(p, "id"), "capsule.event", requestID); e != nil {
			return nil, e
		}
		out := Object{"capsuleId": parent["id"], "eventId": p["id"], "revision": revision}
		if v2 {
			out["versionId"] = versionID
			out["contributorsAuthority"] = "publisher-attributed; source-permission-separate"
			out["coauthorApproval"] = false
			out["capabilityVerified"] = false
		}
		return out, nil
	})
}
