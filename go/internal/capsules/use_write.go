package capsules

import (
	"context"
	"errors"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"sort"
)

func originRef(p Object) Object {
	if o := obj(p["originRef"]); o != nil {
		return o
	}
	o := obj(p["attemptRef"])
	return Object{"kind": "attempt", "id": o["id"], "version": o["version"]}
}
func (s *Service) application(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, p Object, latest bool) (Object, error) {
	origin := originRef(p)
	ref := Object{"kind": origin["kind"], "id": origin["id"], "version": origin["version"], "caseId": p["caseId"]}
	source, e := s.SourceWithin(ctx, tx, a, ref, false, nil)
	if e != nil {
		return nil, e
	}
	resultRef := obj(p["resultRef"])
	result, e := s.SourceWithin(ctx, tx, a, Object{"kind": "result", "id": resultRef["id"], "version": resultRef["version"], "caseId": p["caseId"]}, latest, nil)
	if e != nil {
		return nil, e
	}
	if source["authorId"] != subject(a) || result["authorId"] != subject(a) {
		return nil, fault.New("capsule_application_author_required", 403)
	}
	fact := obj(result["fact"])
	recorded := obj(fact["origin"])
	if recorded["kind"] != origin["kind"] || recorded["id"] != origin["id"] || number(recorded, "version") != number(origin, "version") || fact["reportedOutcome"] != p["outcome"] {
		return nil, fault.New("capsule_result_mismatch", 409)
	}
	environment := Object{"name": "unknown", "version": "unknown"}
	environmentSource := "unknown-origin-conditions"
	if origin["kind"] == "attempt" {
		environmentSource = "recorded-attempt; subject-reported"
		if o := obj(obj(source["fact"])["environment"]); o != nil {
			environment = o
		}
	}
	if selected := obj(p["configurationRef"]); selected != nil {
		if s.Configurations == nil {
			return nil, fault.New("capsule_configuration_source_unavailable", 503)
		}
		found := false
		for _, v := range list(obj(source["fact"])["sourceRefs"]) {
			r := obj(v)
			found = found || r["kind"] == "configuration" && r["id"] == selected["id"] && number(r, "version") == number(selected, "version")
		}
		if !found {
			return nil, fault.New("capsule_configuration_not_in_origin", 409)
		}
		o, e := s.Configurations.RequireReferenceWithin(ctx, tx, a, selected)
		if e != nil {
			return nil, e
		}
		conditions := obj(obj(obj(o["record"])["conditions"])["environment"])
		environment = Object{"name": "unknown", "version": "unknown"}
		for _, k := range []string{"name", "version"} {
			if v := conditions[k]; v != nil {
				environment[k] = v
			}
		}
		environmentSource = "selected-origin-configuration; subject-reported"
	}
	if environment["name"] != obj(p["environment"])["name"] || environment["version"] != obj(p["environment"])["version"] {
		return nil, fault.New("capsule_environment_mismatch", 409)
	}
	if fact["taskId"] != p["taskId"] || fact["participationId"] != p["participationId"] {
		return nil, fault.New("capsule_application_context_mismatch", 409)
	}
	if latest && p["participationId"] != nil {
		if s.Cases == nil || s.Cases.Participation == nil {
			return nil, fault.New("capsule_participation_source_unavailable", 503)
		}
		part, e := s.Cases.Participation(ctx, tx, *a, text(p, "taskId"), text(p, "participationId"))
		if e != nil {
			return nil, e
		}
		if part["subjectId"] != subject(a) || number(part, "scopeVersion") != number(fact, "participationScopeVersion") {
			return nil, fault.New("capsule_application_scope_changed", 403)
		}
	}
	return Object{"origin": source, "result": result, "environmentSource": environmentSource, "synthetic": result["synthetic"], "currentResult": result["currentness"] == "current", "resultCurrentness": result["currentness"]}, nil
}
func useResult(p Object, v2 bool) Object {
	if !v2 {
		return Object{"capsuleId": p["capsuleId"], "eventId": p["id"], "kind": p["kind"]}
	}
	return Object{"eventId": p["id"], "capsuleId": p["capsuleId"], "versionId": p["versionId"], "kind": p["kind"], "reportedOutcome": p["outcome"], "verifiedReuse": false, "capabilityVerified": false}
}
func (s *Service) RecordUseV2(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	return s.recordUse(ctx, a, raw, requestID, true)
}
func (s *Service) RecordUse(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	return s.recordUse(ctx, a, raw, requestID, false)
}
func (s *Service) recordUse(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string, v2 bool) (Object, error) {
	in, e := envelope(raw)
	if e != nil {
		return nil, e
	}
	wire, e := parsePayload(text(in, "payloadJson"), "use", v2)
	if e != nil {
		return nil, e
	}
	p := wire.Values()
	return s.run(ctx, &a, true, false, func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		if v2 && p["taskId"] != nil {
			if s.Cases == nil || s.Cases.TaskRead == nil {
				return nil, fault.New("capsule_participation_source_unavailable", 503)
			}
			if _, e := s.Cases.TaskRead(ctx, tx, a, text(p, "taskId")); e != nil {
				return nil, e
			}
		}
		parent, e := one(ctx, tx, `SELECT * FROM capsules WHERE id=$1 FOR UPDATE`, p["capsuleId"])
		if e != nil {
			return nil, e
		}
		if parent == nil {
			return nil, fault.New("capsule_unavailable", 404)
		}
		var current *version
		if !v2 {
			current, e = s.legacyVersion(ctx, tx, &a, text(p, "capsuleId"), text(p, "versionId"))
			if e != nil {
				return nil, e
			}
		}
		g, e := s.grant(ctx, tx, Object{"id": p["id"], "subject_id": a.SubjectID, "consent_id": in["consentId"], "payload_text": in["payloadJson"]}, "capsule.use")
		if e != nil {
			return nil, e
		}
		if g.Visibility != "Private" && g.Visibility != "Public" {
			return nil, fault.New("capsule_visibility_required", 403)
		}
		table := "capsule_uses"
		if v2 {
			table = "capsule_uses_v2"
		}
		prior, e := one(ctx, tx, `SELECT * FROM `+table+` WHERE id=$1`, p["id"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["subject_id"] != a.SubjectID || prior["payload_hash"] != identity.Digest([]byte(text(in, "payloadJson"))) || prior["consent_id"] != in["consentId"] {
				return nil, fault.New("capsule_use_conflict", 409)
			}
			return useResult(p, v2), nil
		}
		if p["attribution"] != parent["subject_id"] {
			return nil, fault.New("capsule_attribution_mismatch", 409)
		}
		if v2 {
			current, e = s.versionWithin(ctx, tx, &a, text(p, "capsuleId"), text(p, "versionId"), false, false)
			if e != nil {
				return nil, e
			}
			if p["kind"] == "reference" {
				if s.Cases == nil {
					return nil, fault.New("capsule_case_unavailable", 503)
				}
				if _, e := s.Cases.ReadV2Within(ctx, tx, a, text(p, "caseId"), text(p, "taskId")); e != nil {
					return nil, e
				}
			} else {
				if current.deprecated || current.security || current.source["sourceCurrent"] != true {
					return nil, fault.New("capsule_not_applicable", 409)
				}
				if p["caseId"] == obj(current.payload["sourceResolution"])["caseId"] {
					return nil, fault.New("capsule_new_case_required", 409)
				}
				if _, e := s.application(ctx, tx, &a, p, true); e != nil {
					return nil, e
				}
				if p["kind"] == "reverify" {
					prior, e := one(ctx, tx, `SELECT * FROM capsule_uses_v2 WHERE id=$1 AND subject_id=$2 AND version_id=$3 AND case_id=$4 AND kind='apply'`, p["priorUseId"], a.SubjectID, p["versionId"], p["caseId"])
					if e != nil {
						return nil, e
					}
					if text(prior, "payload_text") == "" {
						return nil, fault.New("capsule_application_required", 409)
					}
					if _, e := s.grant(ctx, tx, prior, "capsule.use"); e != nil {
						return nil, e
					}
					original, e := parsePayload(text(prior, "payload_text"), "use", true)
					if e != nil {
						return nil, e
					}
					originalP := original.Values()
					r1, r2 := obj(originalP["resultRef"]), obj(p["resultRef"])
					o1, o2 := originRef(originalP), originRef(p)
					c1, c2 := obj(originalP["configurationRef"]), obj(p["configurationRef"])
					if r1["id"] != r2["id"] || number(r1, "version") != number(r2, "version") || o1["kind"] != o2["kind"] || o1["id"] != o2["id"] || number(o1, "version") != number(o2, "version") || c1["id"] != c2["id"] || c1["version"] != c2["version"] {
						return nil, fault.New("capsule_application_mismatch", 409)
					}
					if s.Records == nil {
						return nil, fault.New("capsule_source_unavailable", 503)
					}
					for _, v := range list(p["verificationRefs"]) {
						ref := obj(v)
						record, e := s.Records.RequireReferenceWithin(ctx, tx, &a, Object{"kind": "verification", "id": ref["id"], "version": ref["version"]}, verificationrecords.ReferenceOptions{CaseID: text(p, "caseId")})
						if e != nil {
							return nil, e
						}
						target := obj(obj(record["record"])["target"])
						if target["type"] != "result" || target["id"] != r2["id"] || number(target, "version") != number(r2, "version") {
							return nil, fault.New("capsule_verification_mismatch", 409)
						}
					}
				}
			}
		} else {
			source, e := s.caseSource(ctx, tx, text(p, "caseId"), a.SubjectID)
			if e != nil {
				return nil, e
			}
			if p["kind"] != "reference" {
				if current.deprecated || current.security || current.source["needsReview"] == true {
					return nil, fault.New("capsule_not_applicable", 409)
				}
				if p["caseId"] == obj(current.payload["sourceResolution"])["caseId"] {
					return nil, fault.New("capsule_new_case_required", 409)
				}
				var result, attempt Object
				for _, row := range rowsOf(source["rows"]) {
					if row["id"] == p["resultId"] && row["kind"] == "result" {
						result = row
					}
					if row["id"] == p["attemptId"] && row["kind"] == "attempt" {
						attempt = row
					}
				}
				rp, ap := obj(result["payload"]), obj(attempt["payload"])
				if result == nil || attempt == nil || rp["attemptId"] != attempt["id"] || rp["outcome"] != p["outcome"] || obj(ap["configuration"])["environment"] != obj(p["environment"])["name"] || obj(ap["configuration"])["version"] != obj(p["environment"])["version"] {
					return nil, fault.New("capsule_result_mismatch", 409)
				}
				if p["kind"] == "reverify" {
					prior, e := one(ctx, tx, `SELECT * FROM capsule_uses WHERE id=$1 AND subject_id=$2 AND version_id=$3 AND case_id=$4 AND kind='apply'`, p["priorUseId"], a.SubjectID, p["versionId"], p["caseId"])
					if e != nil {
						return nil, e
					}
					if prior == nil {
						return nil, fault.New("capsule_application_required", 409)
					}
					if _, e := s.grant(ctx, tx, prior, "capsule.use"); e != nil {
						return nil, e
					}
					if _, e := s.proofReferences(ctx, tx, &a, list(p["proofIds"]), text(p, "caseId"), text(p, "resultId"), true); e != nil {
						return nil, e
					}
				}
			}
		}
		if v2 {
			fingerprint := ""
			if p["kind"] == "reverify" {
				refs := []string{}
				for _, v := range list(p["verificationRefs"]) {
					r := obj(v)
					refs = append(refs, text(r, "id")+":"+fmtVersion(r))
				}
				sort.Strings(refs)
				fingerprint = identity.Digest(encode(refs))
			}
			var origin, result Object
			var attemptID, attemptVersion any
			if p["kind"] != "reference" {
				origin = originRef(p)
				result = obj(p["resultRef"])
				if origin["kind"] == "attempt" {
					attemptID = origin["id"]
					attemptVersion = origin["version"]
				}
			}
			_, e = tx.Exec(ctx, `INSERT INTO capsule_uses_v2(id,capsule_id,version_id,subject_id,case_id,attempt_id,attempt_version,result_id,result_version,prior_use_id,kind,observed_revision,verification_fingerprint,consent_id,payload_text,payload_hash,origin_kind,origin_id,origin_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`, p["id"], p["capsuleId"], p["versionId"], a.SubjectID, p["caseId"], attemptID, attemptVersion, result["id"], result["version"], p["priorUseId"], p["kind"], parent["revision"], fingerprint, in["consentId"], in["payloadJson"], identity.Digest([]byte(text(in, "payloadJson"))), origin["kind"], origin["id"], origin["version"])
		} else {
			_, e = tx.Exec(ctx, `INSERT INTO capsule_uses(id,capsule_id,version_id,subject_id,case_id,attempt_id,result_id,prior_use_id,kind,observed_revision,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, p["id"], p["capsuleId"], p["versionId"], a.SubjectID, p["caseId"], p["attemptId"], p["resultId"], p["priorUseId"], p["kind"], parent["revision"], in["consentId"], in["payloadJson"], identity.Digest([]byte(text(in, "payloadJson"))))
		}
		if e != nil {
			var pg *pgconn.PgError
			if errors.As(e, &pg) && pg.Code == "23505" {
				return nil, fault.New("capsule_use_already_recorded", 409)
			}
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, text(p, "id"), "capsule.use", requestID); e != nil {
			return nil, e
		}
		return useResult(p, v2), nil
	})
}
