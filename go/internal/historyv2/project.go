package historyv2

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5"
)

func (s *Service) taskWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id, subject string) (*ordered, error) {
	task, e := readSource(ctx, tx, a, id, s.Tasks)
	if e != nil {
		return nil, e
	}
	root, e := rootTaskEvent(ctx, tx, id)
	if e != nil || root == nil {
		return nil, e
	}
	t := task.Values()
	participations := []any{}
	roles := []any{}
	if subject == "" || t["requesterId"] == subject {
		roles = append(roles, "requester")
	}
	seenRoles := map[string]bool{}
	activity := []any{root.At}
	hasSubject := false
	for _, v := range arr(t["participations"]) {
		p := obj(v)
		if subject != "" && p["subjectId"] != subject && t["requesterId"] != subject {
			continue
		}
		scope, version := p["agreedScope"], p["scopeVersion"]
		if p["scopeAvailable"] == false {
			scope, version = nil, nil
		}
		events := visible(p["events"])
		participations = append(participations, build("participationId", p["participationId"], "subjectId", p["subjectId"], "role", p["role"], "agreedScope", scope, "scopeVersion", version, "events", events, "deliveries", visible(p["deliveries"]), "capabilityVerified", false, "stateMeaning", "visible-historical-events; use Task for current participation state"))
		for _, v := range arr(events) {
			if at := timestamp(obj(v)["at"]); truthy(at) {
				activity = append(activity, at)
			}
		}
		if subject == "" || p["subjectId"] == subject {
			hasSubject = true
			if role := str(p, "role"); !seenRoles[role] {
				seenRoles[role] = true
				roles = append(roles, role)
			}
		}
	}
	if subject != "" && t["requesterId"] != subject && !hasSubject {
		return nil, nil
	}
	request := obj(t["request"])
	out := build("kind", "task-history", "key", "task:"+id, "taskId", id, "taskIds", []any{id}, "caseId", t["caseId"], "title", request["title"], "summary", request["summary"], "subjectId", subject, "requesterId", t["requesterId"])
	if text := t["textView"]; text != nil {
		out.Set("textView", text)
	}
	out.Set("subjectRoles", roles)
	capabilities := []any{}
	if truthy(request["capabilityId"]) {
		capabilities = append(capabilities, request["capabilityId"])
	}
	out.Set("capabilityIds", capabilities)
	out.Set("participation", participations)
	out.Set("publication", build("eventId", root.ID, "reportedBy", root.Subject, "recordedAt", root.At))
	out.Set("activityTimes", activity)
	out.Set("workPerformedInferred", false)
	out.Set("capabilityVerified", false)
	out.Set("taskOutcomeVerified", false)
	out.Set("sourceScope", "task-publication-and-authorized-participation; not-work-success")
	return out, nil
}
func (s *Service) caseWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id, subject string, tasks []*ordered) (*ordered, error) {
	if s.Cases == nil {
		return nil, fault.New("case_service_unavailable", 503)
	}
	source, e := s.Cases.CaseWithin(ctx, tx, id)
	if e != nil {
		if fault.Code(e) == "case_unavailable" {
			return nil, nil
		}
		return nil, e
	}
	parent := obj(source["parent"])
	if parent == nil || parent["state"] == "withdrawn" {
		return nil, nil
	}
	allRows, _ := source["rows"].([]Object)
	projected, e := s.Cases.ProjectAuthorizedWithin(ctx, tx, a, parent, allRows)
	if e != nil {
		return nil, e
	}
	view := obj(projected["view"])
	safe, _ := projected["rows"].([]Object)
	rowByID := map[string]Object{}
	for _, r := range safe {
		rowByID[str(r, "id")] = r
	}
	reports := []any{}
	rows, e := tx.Query(ctx, `SELECT id::text,object_type,subject_id FROM verification_objects WHERE case_id=$1 ORDER BY id`, id)
	if e != nil {
		return nil, e
	}
	type meta struct{ id, kind, subject string }
	records := []meta{}
	for rows.Next() {
		var r meta
		if e = rows.Scan(&r.id, &r.kind, &r.subject); e != nil {
			rows.Close()
			return nil, e
		}
		records = append(records, r)
	}
	rows.Close()
	if e = rows.Err(); e != nil {
		return nil, e
	}
	for _, r := range records {
		if s.Records == nil {
			return nil, fault.New("verification_service_unavailable", 503)
		}
		report, e := readWire(s.Records.ReadWireWithin(ctx, tx, a, Object{"type": r.kind, "id": r.id}))
		if e != nil {
			if unavailable(e) {
				continue
			}
			return nil, e
		}
		report.Set("reportedBy", r.subject)
		reports = append(reports, report)
	}
	proofs := []any{}
	if s.Proofs != nil {
		proofIDs, e := ids(ctx, tx, `SELECT p.id::text FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id WHERE e.case_id=$1 ORDER BY p.id`, id)
		if e != nil {
			return nil, e
		}
		for _, proofID := range proofIDs {
			p, e := readWire(s.Proofs.ReadWireWithin(ctx, tx, a, proofID, false))
			if e != nil {
				if unavailable(e) {
					continue
				}
				return nil, e
			}
			proofs = append(proofs, build("proofId", proofID, "status", p.Values()["status"], "provenance", p.Values()["provenance"], "capabilityVerified", false, "taskOutcomeVerified", false, "scope", "referenced-ci-run-only"))
		}
	} else {
		var exists bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM proofs p JOIN evidence_submissions e ON e.id=p.evidence_id WHERE e.case_id=$1)`, id).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fault.New("proof_service_unavailable", 503)
		}
	}
	linked := []any{}
	for _, task := range tasks {
		if task.Values()["caseId"] == id {
			linked = append(linked, task)
		}
	}
	reuse := build("items", []any{}, "readingIsReuse", false, "capabilityVerified", false, "sourceScope", "currently-authorized-v2-use-records; no-aggregate-capability")
	if s.CapsuleUses != nil {
		reuse, e = readSource(ctx, tx, a, id, s.CapsuleUses)
		if e != nil {
			return nil, e
		}
	} else {
		var exists bool
		if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM capsule_uses_v2 WHERE case_id=$1)`, id).Scan(&exists); e != nil {
			return nil, e
		}
		if exists {
			return nil, fault.New("capsule_service_unavailable", 503)
		}
	}
	ownRows := 0
	var root Object
	for _, r := range safe {
		if subject == "" || r["subject_id"] == subject {
			ownRows++
		}
		if root == nil && one(r["kind"], "case", "case-created") {
			root = r
		}
	}
	ownReport := false
	for _, r := range reports {
		if subject == "" || obj(r)["reportedBy"] == subject {
			ownReport = true
		}
	}
	if ownRows == 0 && !ownReport && len(linked) == 0 {
		return nil, nil
	}
	attempts := factVersions(view["attempts"], "attempt", rowByID)
	interventions := factVersions(view["interventions"], "intervention", rowByID)
	results := factVersions(view["results"], "result", rowByID)
	hasRef := func(values []any, ref any, current bool) bool {
		r := obj(ref)
		for _, v := range values {
			o := obj(v)
			if o["id"] == r["id"] && num(o, "version") == num(r, "version") && (!current || o["supersededInVisibleHistory"] == false) {
				return true
			}
		}
		return false
	}
	for _, task := range linked {
		for _, participant := range arr(obj(task)["participation"]) {
			p := obj(participant)
			for _, v := range arr(p["deliveries"]) {
				delivery := v.(*ordered)
				d := delivery.Values()
				resultStatus, interventionStatus := "unavailable", "exact-visible-versions"
				if hasRef(results, d["resultRef"], false) {
					resultStatus = "exact-visible-version"
				}
				for _, ref := range arr(d["interventionRefs"]) {
					if !hasRef(interventions, ref, false) {
						interventionStatus = "unavailable"
					}
				}
				delivery.Set("resultReferenceStatus", resultStatus)
				delivery.Set("interventionReferenceStatus", interventionStatus)
				delivery.Set("acceptanceMeaning", "requester-accepted-specific-delivery; not-verification-or-resolution")
				delivery.Set("capabilityVerified", false)
				if resultStatus == "unavailable" || interventionStatus == "unavailable" {
					delivery.Delete("summary")
					if acceptance := obj(d["acceptance"]); acceptance != nil {
						delivery.Set("acceptance", fields(acceptance, "eventId", "actorId", "at"))
					}
					for _, event := range arr(p["events"]) {
						event := obj(event)["event"].(*ordered)
						if event.Values()["eventId"] == d["deliveryId"] || event.Values()["deliveryId"] == d["deliveryId"] {
							event.Delete("summary")
						}
					}
				}
			}
		}
	}
	roles, taskIDs, capIDs := []string{}, []string{}, []string{}
	for _, task := range linked {
		t := obj(task)
		roles = append(roles, stringsOf(t["subjectRoles"])...)
		taskIDs = append(taskIDs, str(t, "taskId"))
		capIDs = append(capIDs, stringsOf(t["capabilityIds"])...)
	}
	if root != nil && (subject == "" || root["subject_id"] == subject) {
		roles = append(roles, "requester")
	}
	for _, v := range attempts {
		o := obj(v)
		if subject == "" || o["actorId"] == subject {
			roles = append(roles, str(o, "role"))
		}
	}
	for _, v := range interventions {
		o := obj(v)
		if subject == "" || o["actorId"] == subject {
			roles = append(roles, stringsOf(o["types"])...)
		}
	}
	for _, v := range reports {
		o := obj(v)
		if (subject == "" || o["reportedBy"] == subject) && o["type"] == "verification" {
			roles = append(roles, "verification-reporter")
		}
	}
	for _, v := range arr(reuse.Values()["items"]) {
		o := obj(v)
		if o["subjectId"] == subject && o["kind"] != "reference" && truthy(o["record"]) {
			roles = append(roles, "capsule-applicant")
		}
	}
	if ownRows > 0 && len(roles) == 0 {
		roles = append(roles, "reporter; executor-unknown")
	}
	events, corrections, activity := []any{}, []any{}, []any{}
	for _, r := range safe {
		payload := obj(r["payload"])
		event := build("eventId", r["id"], "reportedBy", r["subject_id"], "recordedAt", timestamp(r["created_at"]), "payload", visible(r["payload"]))
		events = append(events, event)
		if payload["kind"] == "revision" {
			corrections = append(corrections, event)
		}
		if id := str(payload, "taskId"); id != "" {
			taskIDs = append(taskIDs, id)
		}
		at := payload["observedAt"]
		if at == nil {
			at = payload["endedAt"]
		}
		if at == nil {
			at = payload["startedAt"]
		}
		if at == nil {
			at = event.Values()["recordedAt"]
		}
		if truthy(at) {
			activity = append(activity, at)
		}
	}
	for _, r := range reports {
		o := obj(r)
		at := obj(o["record"])["observedAt"]
		if at == nil {
			at = o["observedAt"]
		}
		if at == nil {
			at = obj(o["provenance"])["recordedAt"]
		}
		if truthy(at) {
			activity = append(activity, at)
		}
	}
	for _, t := range linked {
		activity = append(activity, arr(obj(t)["activityTimes"])...)
	}
	for _, r := range arr(reuse.Values()["items"]) {
		if at := obj(r)["recordedAt"]; truthy(at) {
			activity = append(activity, at)
		}
	}
	responses, resolutions := []any{}, []any{}
	for _, r := range arr(view["responses"]) {
		responses = append(responses, visible(responseWire(r, rowByID)))
	}
	for _, r := range arr(view["resolutions"]) {
		resolutions = append(resolutions, visible(factWire(r, "resolution", rowByID)))
	}
	resolution := visible(factWire(view["resolution"], "resolution", rowByID)).(*ordered)
	missing := false
	for _, ref := range arr(resolution.Values()["resultRefs"]) {
		if !hasRef(results, ref, true) {
			missing = true
		}
	}
	if missing {
		resolution.Set("currentSupport", "referenced-result-superseded")
		resolution.Set("currentDecisionAvailable", false)
	} else if resolution.Values()["status"] != "unrecorded" {
		resolution.Set("currentSupport", "exact-current-visible-references")
		resolution.Set("currentDecisionAvailable", true)
	}
	payload := obj(root["payload"])
	return build("kind", "case-history", "key", "case:"+id, "caseId", id, "subjectId", subject, "title", payload["title"], "summary", payload["summary"], "requesterId", root["subject_id"], "subjectRoles", sortedUnique(roles), "taskIds", sortedUnique(taskIDs), "capabilityIds", sortedUnique(capIDs), "attempts", attempts, "interventions", interventions, "results", results, "responses", responses, "resolutions", resolutions, "resolution", resolution, "verificationRecords", visible(reports), "proofs", proofs, "collaborations", linked, "events", events, "capsuleReuse", reuse, "legacyCorrections", corrections, "activityTimes", activity, "synthetic", view["synthetic"], "configurationMeaning", "reported-attempt-conditions; unknown-is-not-equivalent", "sourceScope", "currently-authorized-facts-and-reports", "capabilityVerified", false, "taskOutcomeVerified", false), nil
}
