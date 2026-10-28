package builders

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
)

func (s *Service) PackUseSubmit(ctx context.Context, a deviceauth.Actor, raw []byte, requestID string) (Object, error) {
	var input Object
	if protocol.Decode(raw, &input) != nil || len(input) != 2 || txt(input, "consentId") == "" {
		return nil, fault.New("invalid_pack_use_request", 400)
	}
	event, e := parsePayload("packUseEventSchema", input, 18000)
	if e != nil {
		return nil, fault.New("invalid_pack_use_request", 400)
	}
	payload := txt(input, "payloadJson")
	hash := identity.Digest([]byte(payload))
	return s.run(ctx, &a, true, event["kind"] == "revoke", func(tx pgx.Tx, auth deviceauth.ControlAuthorization) (Object, error) {
		prior, e := one(ctx, tx, "SELECT operation_id::text,use_id::text,subject_id,payload_hash,consent_id::text,version FROM worker_pack_use_events WHERE operation_id=$1", event["operationId"])
		if e != nil {
			return nil, e
		}
		if prior != nil {
			if prior["use_id"] != event["id"] || prior["subject_id"] != a.SubjectID || prior["payload_hash"] != hash || prior["consent_id"] != input["consentId"] {
				return nil, fault.New("pack_use_operation_conflict", 409)
			}
			return Object{"id": event["id"], "operationId": prior["operation_id"], "version": prior["version"], "acknowledged": true}, nil
		}
		grant, e := s.grant(ctx, tx, Object{"operation_id": event["operationId"], "subject_id": a.SubjectID, "consent_id": input["consentId"], "payload_text": payload}, true)
		if e != nil {
			return nil, e
		}
		if grant.Visibility != "Private" && grant.Visibility != "Public" {
			return nil, fault.New("pack_use_visibility_required", 403)
		}
		if event["kind"] == "record" && num(event, "expectedVersion") == 0 {
			pack := obj(event["pack"])
			if _, e = tx.Exec(ctx, "INSERT INTO worker_pack_uses(id,subject_id,builder_id,manifest_id,case_id,attempt_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", event["id"], a.SubjectID, pack["builderId"], pack["manifestId"], event["caseId"], obj(event["attempt"])["id"]); e != nil {
				return nil, e
			}
		}
		parent, e := one(ctx, tx, "SELECT id::text,subject_id,builder_id::text,manifest_id::text,case_id::text,attempt_id::text,version,state FROM worker_pack_uses WHERE id=$1 AND subject_id=$2 FOR UPDATE", event["id"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		if parent == nil {
			return nil, fault.New("pack_use_unavailable_or_already_recorded", 409)
		}
		if num(parent, "version") != num(event, "expectedVersion") {
			return nil, fault.New("pack_use_version_conflict", 409)
		}
		if parent["state"] != "active" {
			return nil, fault.New("pack_use_revoked", 409)
		}
		if num(parent, "version") >= 1000 {
			return nil, fault.New("pack_use_version_limit", 413)
		}
		if event["kind"] == "record" {
			pack := obj(event["pack"])
			if parent["builder_id"] != pack["builderId"] || parent["manifest_id"] != pack["manifestId"] || parent["case_id"] != event["caseId"] || parent["attempt_id"] != obj(event["attempt"])["id"] {
				return nil, fault.New("pack_use_origin_immutable", 409)
			}
			sources, e := s.packSources(ctx, tx, &a, event, true, num(parent, "version") == 0, a.SubjectID)
			if e != nil {
				return nil, e
			}
			if num(parent, "version") > 0 {
				original, e := one(ctx, tx, "SELECT payload_text FROM worker_pack_use_events WHERE use_id=$1 AND kind='record' ORDER BY version LIMIT 1", parent["id"])
				if e != nil {
					return nil, e
				}
				if original == nil || original["payload_text"] == nil {
					return nil, fault.New("pack_use_source_erased", 409)
				}
				parsed, e := protocol.DecodeOrdered([]byte(txt(original, "payload_text")))
				if e != nil {
					return nil, e
				}
				old := obj(parsed)
				if !sameRef(obj(old["configuration"]), obj(event["configuration"])) || !equal(old["follows"], event["follows"]) {
					return nil, fault.New("pack_use_origin_immutable", 409)
				}
			}
			if follows := obj(event["follows"]); follows != nil {
				if follows["id"] == event["id"] {
					return nil, fault.New("pack_use_circular_relation", 422)
				}
				old, e := s.PackUseReadWithin(ctx, tx, &a, Object{"id": follows["id"]})
				if e != nil {
					return nil, e
				}
				record := obj(old["record"])
				if old["subjectId"] != a.SubjectID || record == nil || obj(record["attempt"])["id"] == obj(event["attempt"])["id"] {
					return nil, fault.New("pack_use_prior_unavailable", 422)
				}
				if follows["kind"] == "upgrade" && (obj(record["pack"])["builderId"] != pack["builderId"] || obj(record["pack"])["manifestId"] == pack["manifestId"] || sameRef(obj(record["configuration"]), obj(event["configuration"]))) {
					return nil, fault.New("pack_use_upgrade_requires_new_configuration", 422)
				}
			}
			if obj(sources["attempt"])["actorId"] != a.SubjectID {
				return nil, fault.New("pack_use_attempt_author_required", 403)
			}
		} else if num(parent, "version") == 0 {
			return nil, fault.New("pack_use_unavailable", 404)
		}
		version := num(parent, "version") + 1
		if _, e = tx.Exec(ctx, "INSERT INTO worker_pack_use_events(operation_id,use_id,subject_id,version,kind,consent_id,payload_text,payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", event["operationId"], event["id"], a.SubjectID, version, event["kind"], input["consentId"], payload, hash); e != nil {
			return nil, e
		}
		state := "active"
		if event["kind"] == "revoke" {
			state = "revoked"
		}
		if _, e = tx.Exec(ctx, "UPDATE worker_pack_uses SET version=$2,state=$3 WHERE id=$1", event["id"], version, state); e != nil {
			return nil, e
		}
		if e = s.audit(ctx, tx, a, auth, txt(event, "operationId"), "worker-pack.event", requestID); e != nil {
			return nil, e
		}
		return Object{"id": event["id"], "operationId": event["operationId"], "version": version, "acknowledged": true}, nil
	})
}
func (s *Service) PackUseReadWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, input Object) (Object, error) {
	parent, e := one(ctx, tx, "SELECT id::text,subject_id,version,state FROM worker_pack_uses WHERE id=$1 FOR SHARE", input["id"])
	if e != nil {
		return nil, e
	}
	if parent == nil {
		return nil, fault.New("pack_use_unavailable", 404)
	}
	owner := a != nil && parent["subject_id"] == a.SubjectID
	version := num(parent, "version")
	if input["version"] != nil {
		version = num(input, "version")
	}
	base := Object{"id": parent["id"], "subjectId": parent["subject_id"], "version": version, "currentVersion": parent["version"], "state": parent["state"], "workerStarted": false, "successfulReuseVerified": false, "professionalCapabilityVerified": false}
	read := func() (Object, error) {
		row, g, event, e := s.packEvent(ctx, tx, a, parent, version)
		if e != nil {
			return nil, e
		}
		if parent["state"] == "revoked" || event["kind"] == "revoke" {
			out := clone(base)
			out["record"] = nil
			out["sourceStatus"] = "revoked"
			return out, nil
		}
		if version != num(parent, "version") {
			if _, _, _, e = s.packEvent(ctx, tx, a, parent, num(parent, "version")); e != nil {
				return nil, e
			}
		}
		sources, e := s.packSources(ctx, tx, a, event, false, false, txt(parent, "subject_id"))
		if e != nil {
			return nil, e
		}
		out := clone(base)
		for k, v := range (Object{"record": event, "sources": sources, "sourceStatus": "available", "payloadHash": row["payload_hash"]}) {
			out[k] = v
		}
		if owner {
			out["disclosure"] = Object{"visibility": g.Visibility, "viewers": g.Viewers}
		}
		return out, nil
	}
	out, e := read()
	if e != nil && owner && missing(e) {
		out = clone(base)
		out["record"] = nil
		out["sources"] = nil
		out["sourceStatus"] = "unavailable"
		return out, nil
	}
	return out, e
}
func (s *Service) PackUseRead(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("packUseReadSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.PackUseReadWithin(ctx, tx, a, input)
	})
}
func (s *Service) PackUseQuery(ctx context.Context, a *deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("packUseQuerySchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, "SELECT id::text FROM worker_pack_uses WHERE ($1::uuid IS NULL OR builder_id=$1) AND ($2::text IS NULL OR subject_id=$2) AND ($3::uuid IS NULL OR id>$3) ORDER BY id", input["builderId"], input["subjectId"], input["after"])
		if e != nil {
			return nil, e
		}
		items := []any{}
		limit := int(num(input, "limit"))
		for _, row := range rows {
			v, e := s.PackUseReadWithin(ctx, tx, a, Object{"id": row["id"]})
			if e != nil {
				if missing(e) {
					continue
				}
				return nil, e
			}
			items = append(items, v)
			if len(items) > limit {
				break
			}
		}
		var after any
		if len(items) > limit {
			items = items[:limit]
			after = obj(items[len(items)-1])["id"]
		}
		return Object{"items": items, "nextAfter": after, "coverage": "current-authorized-associations", "countsAreCapabilityScores": false}, nil
	})
}
func (s *Service) PackUseReceipt(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("packUseReceiptSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		row, e := one(ctx, tx, "SELECT use_id::text,version,consent_id::text,payload_hash FROM worker_pack_use_events WHERE operation_id=$1 AND subject_id=$2", input["operationId"], a.SubjectID)
		if e != nil {
			return nil, e
		}
		state := "absent"
		if row != nil {
			state = "conflict"
			if row["payload_hash"] == input["payloadHash"] {
				state = "acknowledged"
			}
		}
		out := Object{"operationId": input["operationId"], "state": state, "currentReadPermissionConfirmed": false}
		if state == "acknowledged" {
			out["id"] = row["use_id"]
			out["version"] = row["version"]
			out["consentId"] = row["consent_id"]
		}
		return out, nil
	})
}
func (s *Service) PackUseCandidates(ctx context.Context, a deviceauth.Actor, raw []byte) (Object, error) {
	input, e := parse("packUseCandidatesSchema", raw)
	if e != nil {
		return nil, e
	}
	return s.run(ctx, &a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rows, e := query(ctx, tx, "SELECT DISTINCT case_id::text FROM case_events WHERE subject_id=$1 AND kind='attempt-start' AND ($2::uuid IS NULL OR case_id=$2) AND ($3::uuid IS NULL OR case_id>$3) ORDER BY case_id", a.SubjectID, input["caseId"], input["after"])
		if e != nil {
			return nil, e
		}
		items := []any{}
		limit := int(num(input, "limit"))
		for _, row := range rows {
			item, e := func() (Object, error) {
				facts, e := s.caseFacts(ctx, tx, &a, txt(row, "case_id"))
				if e != nil {
					return nil, e
				}
				attempts := []any{}
				for _, raw := range arr(facts["attempts"]) {
					v := obj(raw)
					if v["actorId"] == a.SubjectID && v["configurationRef"] != nil && obj(v["configurationCondition"])["record"] != nil {
						attempts = append(attempts, v)
					}
				}
				if len(attempts) == 0 {
					return nil, nil
				}
				evidence, verifications := []any{}, []any{}
				records, e := query(ctx, tx, "SELECT id::text,object_type,version FROM verification_objects WHERE case_id=$1 ORDER BY id", row["case_id"])
				if e != nil {
					return nil, e
				}
				for _, record := range records {
					if s.VerificationRecords == nil {
						return nil, fault.New("verification_records_unavailable", 503)
					}
					view, e := s.VerificationRecords.RequireReferenceWithin(ctx, tx, &a, Object{"kind": record["object_type"], "id": record["id"], "version": record["version"]}, verificationrecords.ReferenceOptions{CaseID: txt(row, "case_id")})
					if e != nil {
						if missing(e) {
							continue
						}
						return nil, e
					}
					if record["object_type"] == "evidence" {
						evidence = append(evidence, view)
					} else {
						verifications = append(verifications, view)
					}
				}
				results := []any{}
				for _, raw := range arr(facts["results"]) {
					r := obj(raw)
					if r["actorId"] != a.SubjectID || obj(r["origin"])["kind"] != "attempt" {
						continue
					}
					for _, attempt := range attempts {
						if sameRef(obj(attempt), obj(r["origin"])) {
							results = append(results, r)
							break
						}
					}
				}
				var summary any
				scopes := arr(facts["scopes"])
				if len(scopes) > 0 {
					summary = obj(scopes[len(scopes)-1])["summary"]
				}
				return Object{"caseId": row["case_id"], "summary": summary, "attempts": attempts, "results": results, "evidence": evidence, "verifications": verifications, "synthetic": facts["synthetic"]}, nil
			}()
			if e != nil {
				if missing(e) {
					continue
				}
				return nil, e
			}
			if item == nil {
				continue
			}
			items = append(items, item)
			if len(items) > limit {
				break
			}
		}
		var after any
		if len(items) > limit {
			items = items[:limit]
			after = obj(items[len(items)-1])["caseId"]
		}
		return Object{"items": items, "nextAfter": after, "automaticExecution": false}, nil
	})
}
