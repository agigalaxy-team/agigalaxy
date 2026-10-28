package builders

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
	"github.com/jackc/pgx/v5"
)

func sameRef(a, b Object) bool {
	return a != nil && b != nil && a["id"] == b["id"] && num(a, "version") == num(b, "version")
}
func exactFact(values any, ref Object) Object {
	for _, raw := range arr(values) {
		v := obj(raw)
		if sameRef(v, ref) {
			return v
		}
	}
	return nil
}
func (s *Service) caseFacts(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	if s.Cases == nil {
		return nil, fault.New("pack_use_case_unavailable", 503)
	}
	source, e := s.Cases.CaseWithin(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	parent := obj(source["parent"])
	if parent == nil || parent["state"] == "withdrawn" {
		return nil, fault.New("pack_use_case_unavailable", 404)
	}
	rows, _ := source["rows"].([]Object)
	projected, e := s.Cases.ProjectAuthorizedWithin(ctx, tx, a, parent, rows)
	if e != nil {
		return nil, e
	}
	return obj(projected["view"]), nil
}
func (s *Service) packEvent(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, parent Object, version int64) (Object, deviceauth.ConsentIntent, Object, error) {
	row, e := one(ctx, tx, "SELECT operation_id::text,use_id::text,subject_id,version,kind,consent_id::text,payload_text,payload_hash FROM worker_pack_use_events WHERE use_id=$1 AND version=$2", parent["id"], version)
	if e != nil {
		return nil, deviceauth.ConsentIntent{}, nil, e
	}
	if row == nil || row["payload_text"] == nil {
		return nil, deviceauth.ConsentIntent{}, nil, fault.New("pack_use_unavailable", 404)
	}
	if identity.Digest([]byte(txt(row, "payload_text"))) != row["payload_hash"] {
		return nil, deviceauth.ConsentIntent{}, nil, fault.New("pack_use_integrity_mismatch", 500)
	}
	g, e := s.grant(ctx, tx, row, true)
	if e != nil {
		return nil, g, nil, e
	}
	if !s.visible(g, a) {
		return nil, g, nil, fault.New("pack_use_unavailable", 404)
	}
	event, e := parse("packUseEventSchema", []byte(txt(row, "payload_text")))
	return row, g, event, e
}
func (s *Service) packSources(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, event Object, write, requireConfiguration bool, subject string) (Object, error) {
	pack, e := s.ManifestWithin(ctx, tx, a, obj(event["pack"]))
	if e != nil {
		return nil, e
	}
	if write && (pack["delisted"] == true || pack["securityIssue"] == true) {
		return nil, fault.New("pack_use_maintenance_blocked", 409)
	}
	facts, e := s.caseFacts(ctx, tx, a, txt(event, "caseId"))
	if e != nil {
		return nil, e
	}
	attempt := exactFact(facts["attempts"], obj(event["attempt"]))
	if attempt == nil || attempt["provenance"] != "native-v2" {
		return nil, fault.New("pack_use_attempt_unavailable", 404)
	}
	if attempt["actorId"] != subject {
		return nil, fault.New("pack_use_attempt_author_required", 403)
	}
	if !sameRef(obj(attempt["configurationRef"]), obj(event["configuration"])) {
		return nil, fault.New("pack_use_configuration_mismatch", 422)
	}
	if s.Configurations == nil {
		return nil, fault.New("pack_use_configuration_unavailable", 503)
	}
	configuration, e := s.Configurations.ConditionWithin(ctx, tx, a, event["configuration"])
	if e != nil {
		return nil, e
	}
	if requireConfiguration && configuration["record"] == nil {
		return nil, fault.New("pack_use_configuration_unavailable", 403)
	}
	var result Object
	if event["result"] != nil {
		result = exactFact(facts["results"], obj(event["result"]))
		if result == nil {
			return nil, fault.New("pack_use_result_unavailable", 404)
		}
		origin := obj(result["origin"])
		if result["actorId"] != subject || origin["kind"] != "attempt" || !sameRef(origin, obj(event["attempt"])) {
			return nil, fault.New("pack_use_result_origin_mismatch", 422)
		}
	}
	evidence, verifications := []any{}, []any{}
	authors := []any{}
	seen := map[string]bool{}
	for _, kind := range []string{"evidence", "verification"} {
		key := "evidenceRefs"
		if kind == "verification" {
			key = "verificationRefs"
		}
		for _, raw := range arr(event[key]) {
			ref := obj(raw)
			if s.VerificationRecords == nil {
				return nil, fault.New("verification_records_unavailable", 503)
			}
			view, e := s.VerificationRecords.RequireReferenceWithin(ctx, tx, a, Object{"kind": kind, "id": ref["id"], "version": ref["version"]}, verificationrecords.ReferenceOptions{CaseID: txt(event, "caseId")})
			if e == nil && kind == "verification" {
				target := obj(obj(view["record"])["target"])
				if !(target["type"] == "attempt" && sameRef(target, obj(event["attempt"])) || target["type"] == "result" && event["result"] != nil && sameRef(target, obj(event["result"]))) {
					e = fault.New("pack_use_verification_target_mismatch", 422)
				}
			}
			var item Object
			if e != nil {
				if write || !missing(e) {
					return nil, e
				}
				item = Object{"id": ref["id"], "version": ref["version"], "state": "unavailable", "record": nil, "executionAttributionVerified": false}
			} else {
				relationship := "runner-associated-supporting-material"
				if kind == "verification" {
					relationship = "reported-verification-of-exact-target"
					author := txt(obj(view["record"]), "reportedBy")
					if !seen[author] {
						seen[author] = true
						authors = append(authors, author)
					}
				}
				item = Object{"id": ref["id"], "version": ref["version"], "state": "current", "record": view["record"], "provenance": view["provenance"], "relationship": relationship, "executionAttributionVerified": false}
			}
			if kind == "evidence" {
				evidence = append(evidence, item)
			} else {
				verifications = append(verifications, item)
			}
		}
	}
	attemptStatus, resultStatus := "historical-version", "current"
	var last Object
	for _, raw := range arr(facts["attempts"]) {
		v := obj(raw)
		if v["id"] == attempt["id"] {
			last = v
		}
	}
	if num(last, "version") == num(attempt, "version") {
		attemptStatus = "current"
	}
	if result != nil {
		for _, raw := range arr(facts["results"]) {
			v := obj(raw)
			if v["id"] == result["id"] {
				last = v
			}
		}
		if num(last, "version") != num(result, "version") {
			resultStatus = "historical-version"
		}
	}
	outcome := any("unrecorded")
	if attempt["reportedOutcome"] != nil {
		outcome = attempt["reportedOutcome"]
	}
	if result["reportedOutcome"] != nil {
		outcome = result["reportedOutcome"]
	}
	return Object{"pack": pack, "configuration": configuration, "attempt": attempt, "result": nullable(result), "evidence": evidence, "verifications": verifications, "synthetic": facts["synthetic"], "attemptVersionStatus": attemptStatus, "resultVersionStatus": resultStatus, "reportedOutcome": outcome, "resolution": obj(facts["resolution"])["status"], "executionAttribution": "runner-signed-association; not-independently-proven", "roles": Object{"packAuthorId": pack["authorId"], "runnerId": attempt["actorId"], "configurationAuthorId": nullable(configuration["subjectId"]), "resultAuthorId": nullable(result["actorId"]), "verificationAuthorIds": authors}, "successfulReuseVerified": false, "professionalCapabilityVerified": false}, nil
}
