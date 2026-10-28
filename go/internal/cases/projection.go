package cases

import (
	"context"
	"errors"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) GetV2(ctx context.Context, a deviceauth.Actor, id string, raw []byte) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	var input Object
	if len(raw) > 0 {
		var e error
		input, e = parseLoose(raw)
		if e != nil {
			return nil, e
		}
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		return s.ReadV2Within(ctx, tx, a, id, text(input, "taskId"))
	})
}
func (s *Service) ReadV2Within(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, id, taskID string) (Object, error) {
	return s.readV2Within(ctx, tx, &a, a.SubjectID, id, taskID)
}
func (s *Service) readV2Within(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, viewer, id, taskID string) (Object, error) {
	if !uuidPattern.MatchString(id) {
		return nil, fault.New("not_found", 404)
	}
	var task Object
	if taskID != "" {
		if s.TaskRead == nil && s.grantAuthor == "" || s.grantAuthor != "" && s.GrantAuthorTaskRead == nil {
			return nil, fault.New("task_service_unavailable", 503)
		}
		var e error
		if s.grantAuthor != "" {
			task, e = s.GrantAuthorTaskRead(ctx, tx, s.grantAuthor, taskID)
		} else {
			task, e = s.TaskRead(ctx, tx, *a, taskID)
		}
		if e != nil {
			return nil, e
		}
	}
	parent, e := queryOne(ctx, tx, `SELECT id::text,subject_id,local_ref,source_ref,version,state,created_at FROM cases WHERE id=$1 FOR SHARE`, id)
	if e != nil {
		return nil, e
	}
	if parent == nil || parent["subject_id"] != viewer && task["caseId"] != id {
		return nil, fault.New("not_found", 404)
	}
	if parent["state"] == "withdrawn" {
		return nil, fault.New("case_withdrawn", 409)
	}
	rows, e := events(ctx, tx, id)
	if e != nil {
		return nil, e
	}
	projected, e := s.ProjectAuthorizedWithin(ctx, tx, a, parent, rows)
	if e != nil {
		return nil, e
	}
	return object(projected["view"]), nil
}
func responseKey(ref Object, subject string) string {
	return fmt.Sprintf("%s:%d:%s", text(ref, "id"), number(ref, "version"), subject)
}
func (s *Service) ProjectAuthorizedWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, parent Object, rows []Object) (Object, error) {
	if len(rows) > 1000 {
		return nil, fault.New("case_event_limit", 413)
	}
	visible := []Object{}
	for _, r := range rows {
		_, e := s.RequireEventVisibleWithin(ctx, tx, a, r)
		if e == nil {
			visible = append(visible, r)
			continue
		}
		var se *fault.Error
		if !errors.As(e, &se) || !one(se.Code, "consent_required", "origin_not_authorized", "case_event_unavailable") {
			return nil, e
		}
	}
	retained := []Object{}
	for _, r := range rows {
		if text(r, "payload_text") != "" {
			retained = append(retained, r)
		}
	}
	all := ProjectFacts(retained, parent)
	safe := []Object{}
	reasons := []any{}
	seen := map[string]bool{}
	reason := func(code string) {
		if !seen[code] {
			seen[code] = true
			reasons = append(reasons, code)
		}
	}
	for _, row := range visible {
		available := ProjectFacts(safe, parent)
		p := object(row["payload"])
		refs := append(append([]any{}, list(p["sourceRefs"])...), list(p["deliverableRefs"])...)
		if p["origin"] != nil {
			refs = append(refs, p["origin"])
		}
		for _, entry := range []struct{ key, kind string }{{"attemptRef", "attempt"}, {"interventionRef", "intervention"}} {
			if ref := object(p[entry.key]); ref != nil {
				v := copyObject(ref)
				v["kind"] = entry.kind
				refs = append(refs, v)
			}
		}
		if p["kind"] == "intervention" {
			priorRows := []Object{}
			for _, r := range rows {
				if number(r, "version") < number(row, "version") {
					priorRows = append(priorRows, r)
				}
			}
			prior := ProjectFacts(priorRows, parent)
			for _, id := range list(p["affectsAttemptIds"]) {
				attempt := LatestFact(prior, "attempt", id.(string))
				refs = append(refs, Object{"kind": "attempt", "id": id, "version": number(attempt, "version")})
			}
		}
		if p["kind"] == "resolution-recorded" {
			for _, r := range list(p["resultRefs"]) {
				ref := copyObject(object(r))
				ref["kind"] = "result"
				refs = append(refs, ref)
			}
		}
		var failed error
		for _, ref := range refs {
			if _, failed = s.RequireSourceWithin(ctx, tx, a, rows, available, object(ref)); failed != nil {
				break
			}
		}
		if failed == nil && p["kind"] == "resolution-recorded" {
			for _, ref := range list(p["verificationRefs"]) {
				if s.VerificationReference == nil && s.grantAuthor == "" || s.grantAuthor != "" && s.GrantAuthorVerificationReference == nil {
					failed = fault.New("verification_access_unavailable", 503)
					break
				}
				if s.grantAuthor != "" {
					_, failed = s.GrantAuthorVerificationReference(ctx, tx, s.grantAuthor, object(ref), text(parent, "id"), number(p, "taskScopeVersion"))
				} else {
					_, failed = s.VerificationReference(ctx, tx, a, object(ref), text(parent, "id"), number(p, "taskScopeVersion"))
				}
				if failed != nil {
					break
				}
			}
		}
		if failed != nil {
			var se *fault.Error
			if !errors.As(failed, &se) {
				return nil, failed
			}
			reason(se.Code)
		} else {
			safe = append(safe, row)
		}
	}
	projected := ProjectFacts(safe, parent)
	latest := map[string]Object{}
	latestKeys := []string{}
	erased := map[string]int64{}
	erasedSubjects := []string{}
	safeIDs := map[string]bool{}
	for _, r := range safe {
		safeIDs[text(r, "id")] = true
	}
	for _, row := range rows {
		if row["kind"] != "intervention-response" {
			continue
		}
		subject := text(row, "subject_id")
		if text(row, "payload_text") == "" {
			if _, ok := erased[subject]; !ok {
				erasedSubjects = append(erasedSubjects, subject)
			}
			erased[subject] = number(row, "version")
			continue
		}
		ref := object(object(row["payload"])["interventionRef"])
		key := responseKey(ref, subject)
		if _, ok := latest[key]; !ok {
			latestKeys = append(latestKeys, key)
		}
		latest[key] = row
	}
	for _, v := range list(projected["interventions"]) {
		intervention := object(v)
		current := map[string]bool{}
		complete := true
		for _, key := range latestKeys {
			row := latest[key]
			ref := object(object(row["payload"])["interventionRef"])
			if ref["id"] != intervention["id"] || number(ref, "version") != number(intervention, "version") {
				continue
			}
			if safeIDs[text(row, "id")] && number(row, "version") > erased[text(row, "subject_id")] {
				current[text(row, "id")] = true
			} else {
				complete = false
			}
		}
		for _, subject := range erasedSubjects {
			version := erased[subject]
			if version <= number(intervention, "caseVersion") {
				continue
			}
			later := latest[responseKey(intervention, subject)]
			if later == nil || number(later, "version") <= version || !safeIDs[text(later, "id")] {
				complete = false
			}
		}
		responses := []any{}
		confirmation := "unconfirmed"
		for _, r := range list(intervention["responses"]) {
			r := object(r)
			if current[text(r, "id")] {
				responses = append(responses, r)
			}
		}
		for _, r := range responses {
			o := object(r)
			if o["relationship"] == "self" {
				continue
			}
			if o["state"] == "disputed" {
				confirmation = "disputed"
				break
			}
			if o["state"] == "partial" {
				confirmation = "partially-confirmed"
			} else if o["state"] == "accepted" && confirmation == "unconfirmed" {
				confirmation = "confirmed"
			}
		}
		intervention["responses"] = responses
		intervention["confirmation"] = confirmation
		intervention["responseCoverage"] = Object{"mode": "currently-authorized-latest-per-actor", "complete": complete}
		if !complete {
			reason("intervention_response_currentness_unavailable")
		}
	}
	projected["resolution"] = CurrentResolution(projected, all)
	decision := object(projected["resolution"])
	unknown := false
	if decision["status"] != "unrecorded" {
		for _, ref := range list(decision["resultRefs"]) {
			result := FactAt(all, "result", object(ref))
			if result == nil {
				continue
			}
			for _, r := range rows {
				if r["kind"] == "result-recorded" && text(r, "payload_text") == "" && r["subject_id"] == result["actorId"] && number(r, "version") > number(decision, "caseVersion") {
					unknown = true
					break
				}
			}
		}
	}
	if unknown {
		projected["resolution"] = Object{"status": "unrecorded", "scopeVersion": projected["scopeVersion"], "priorResolutionId": decision["id"], "currentSupport": "referenced-result-currentness-unavailable", "currentDecisionAvailable": false, "reconfirmationRequired": true, "summary": "结果当前版本资料不完整，当前解决程度需要重新确认。"}
	}
	view := object(PublicFacts(projected))
	for _, v := range list(view["attempts"]) {
		attempt := object(v)
		condition := Object{"reference": attempt["configurationRef"], "sourceStatus": "unavailable", "record": nil, "conditionsKnown": false}
		if s.grantAuthor != "" && s.GrantAuthorConfigurationCondition != nil || s.grantAuthor == "" && s.ConfigurationCondition != nil {
			var e error
			if s.grantAuthor != "" {
				condition, e = s.GrantAuthorConfigurationCondition(ctx, tx, s.grantAuthor, attempt["configurationRef"])
			} else {
				condition, e = s.ConfigurationCondition(ctx, tx, a, attempt["configurationRef"])
			}
			if e != nil {
				return nil, e
			}
		}
		attempt["configurationCondition"] = condition
	}
	view["synthetic"] = all["synthetic"]
	view["legacyState"] = parent["state"]
	view["coverage"] = Object{"mode": "authorized-events", "visibleEvents": len(safe), "complete": len(safe) == len(rows), "unavailableReasons": reasons}
	exposed := []any{}
	for _, r := range safe {
		p := Object{"caseVersion": r["version"]}
		for k, v := range object(r["payload"]) {
			p[k] = v
		}
		exposed = append(exposed, p)
	}
	view["events"] = exposed
	return Object{"view": view, "rows": safe, "unavailableReasons": reasons}, nil
}
