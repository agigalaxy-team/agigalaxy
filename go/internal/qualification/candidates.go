package qualification

import (
	"context"

	"github.com/jackc/pgx/v5"
)

var candidateQueries = map[string]string{
	"participation":     "SELECT jsonb_build_object('id',id) FROM task_participations WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80",
	"external-review":   "SELECT jsonb_build_object('id',r.id,'version',r.version) FROM experience_objects r JOIN experience_objects e ON e.id=r.experience_id WHERE e.subject_id=$1 AND r.object_type='review' AND ($2::uuid IS NULL OR r.id>$2) ORDER BY r.id LIMIT 80",
	"calculation":       "SELECT jsonb_build_object('id',id) FROM qualification_calculation_grants WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80",
	"capsule-use":       "SELECT jsonb_build_object('id',id) FROM capsule_uses_v2 WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80",
	"proof":             "SELECT jsonb_build_object('id',id) FROM proofs WHERE subject_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80",
	"legacy-assistance": "SELECT jsonb_build_object('id',id) FROM assistance_requests WHERE snapshot->'selected'->>'providerId'=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 80",
}

func readRows(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]Object, error) {
	rows, e := tx.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Object{}
	for rows.Next() {
		var row Object
		if e = rows.Scan(&row); e != nil {
			return nil, e
		}
		out = append(out, row)
	}
	return out, rows.Err()
}
func (s *Service) Candidates(ctx context.Context, a Actor, input Object) (any, error) {
	if !queryClosed(input, []string{"taskId", "kind"}, []string{"after", "limit"}) || !uuidPattern.MatchString(str(input, "taskId")) || candidateQueries[str(input, "kind")] == "" {
		return nil, fail("invalid_qualification_candidates", 400)
	}
	var after any
	if v, ok := input["after"]; ok {
		if !uuidPattern.MatchString(text(v)) {
			return nil, fail("invalid_qualification_candidates", 400)
		}
		after = v
	}
	limit := int64(12)
	if v, ok := input["limit"]; ok {
		if !positiveInteger(v) || number(v) > 30 {
			return nil, fail("invalid_qualification_candidates", 400)
		}
		limit = number(v)
	}
	kind := str(input, "kind")
	return s.run(ctx, a, func(tx pgx.Tx) (any, error) {
		if s.Assistance == nil {
			return nil, fail("qualification_assistance_unavailable", 503)
		}
		if kind == "external-review" && s.ReadExperienceReview == nil {
			return nil, fail("qualification_experience_review_unavailable", 503)
		}
		if kind == "capsule-use" && s.ReadCapsuleUse == nil {
			return nil, fail("qualification_capsule_source_unavailable", 503)
		}
		if kind == "proof" && s.Proofs == nil {
			return nil, fail("qualification_proof_unavailable", 503)
		}
		target, e := s.Assistance.RequireTaskWithin(ctx, tx, &a.Actor, str(input, "taskId"), false)
		if e != nil {
			return nil, e
		}
		request := object(object(target["snapshot"])["request"])
		var policy Object
		if ref := object(request["qualification"]); ref != nil {
			policy, e = s.PolicyWithin(ctx, tx, str(ref, "policyId"), str(ref, "policyVersion"), str(request, "capabilityId"), str(request, "collaboration"))
			if e != nil {
				return nil, e
			}
		}
		items := []any{}
		cursor := after
		done := false
		for !done && int64(len(items)) <= limit {
			rows, e := readRows(ctx, tx, candidateQueries[kind], a.SubjectID, cursor)
			if e != nil {
				return nil, e
			}
			done = len(rows) < 80
			for _, row := range rows {
				cursor = row["id"]
				item, e := s.candidateWithin(ctx, tx, a, input, kind, row, target, policy)
				if e != nil {
					if !unavailable(e) {
						return nil, e
					}
					continue
				}
				if item != nil {
					items = append(items, item)
					if int64(len(items)) > limit {
						break
					}
				}
			}
		}
		var next any
		if int64(len(items)) > limit {
			next = object(items[limit-1])["id"]
		}
		return Object{"schemaVersion": 2, "subjectId": a.SubjectID, "taskId": input["taskId"], "kind": kind, "items": items[:min(len(items), int(limit))], "nextAfter": next, "checkedAt": s.now(), "qualificationGranted": false, "sourcePermissionsChanged": false, "coverage": "currently-authorized-owned-materials; current evaluation required"}, nil
	})
}
func (s *Service) candidateWithin(ctx context.Context, tx pgx.Tx, a Actor, input Object, kind string, row, target, policy Object) (Object, error) {
	id := str(row, "id")
	item := Object{"id": id, "kind": kind}
	switch kind {
	case "participation":
		if policy == nil {
			return nil, nil
		}
		r, e := s.participationWithin(ctx, tx, &a.Actor, id, a.SubjectID, policy, nil)
		if e != nil {
			return nil, e
		}
		label := r["scope"]
		if label == nil {
			label = "已有参与，当前接受依据不足"
		}
		status := r["reason"]
		if r["usable"] == true {
			status = "current-accepted-scope"
		}
		item["label"], item["role"], item["taskId"], item["sourceStatus"], item["synthetic"], item["evidence"] = label, r["role"], r["taskId"], status, r["synthetic"], Object{"participationIds": []any{id}}
	case "external-review":
		r, e := s.ReadExperienceReview(ctx, tx, a.Actor, Object{"id": row["id"], "version": row["version"]})
		if e != nil {
			return nil, e
		}
		record := object(r["record"])
		if r["referenceStatus"] != "current" || record == nil || r["experienceSubjectId"] != a.SubjectID || policy != nil && record["capabilityId"] != policy["capabilityId"] {
			return nil, nil
		}
		item["version"], item["label"], item["sourceStatus"], item["synthetic"], item["evidence"] = row["version"], record["scope"], record["state"], r["synthetic"], Object{"externalReviewRefs": []any{Object{"id": row["id"], "version": row["version"]}}}
	case "calculation":
		r, e := s.readCalculationWithin(ctx, tx, a.Actor, id)
		if e != nil {
			return nil, e
		}
		c := r.Payload
		if c["kind"] != "compute" || c["taskId"] != input["taskId"] || c["candidateId"] != a.SubjectID || c["recipientId"] != target["requesterId"] {
			return nil, nil
		}
		evidence := Object{}
		for k, v := range object(c["evidence"]) {
			evidence[k] = v
		}
		evidence["calculationGrantId"] = id
		if _, e = s.CalculationContextWithin(ctx, tx, a.Actor, Object{"taskId": input["taskId"], "subjectId": a.SubjectID, "evidence": evidence}); e != nil {
			return nil, e
		}
		item["label"], item["sourceStatus"], item["expiresAt"], item["evidence"] = "本任务限定资格计算许可", "current-licensed-computation", c["expiresAt"], evidence
	case "capsule-use":
		raw, e := readRow(ctx, tx, "SELECT to_jsonb(u) FROM capsule_uses_v2 u WHERE id=$1", id)
		if e != nil {
			return nil, e
		}
		r, e := s.ReadCapsuleUse(ctx, tx, a.Actor, raw)
		if e != nil {
			return nil, e
		}
		if r["record"] == nil || r["sourceStatus"] != "current" || r["kind"] == "reference" {
			return nil, nil
		}
		item["label"], item["sourceStatus"], item["synthetic"], item["evidence"] = "已记录的实际应用；仍需限定审核", "actual-application-requires-scoped-review", r["synthetic"], Object{"capsuleUseIds": []any{id}}
	case "legacy-assistance":
		r, e := s.Assistance.LegacyReadWithin(ctx, tx, &a.Actor, id)
		if e != nil {
			return nil, e
		}
		if object(r["selected"])["providerId"] != a.SubjectID || policy != nil && object(r["request"])["capabilityId"] != policy["capabilityId"] {
			return nil, nil
		}
		status := "legacy-not-yet-accepted"
		if r["state"] == "accepted" {
			status = "legacy-accepted-current-check-required"
		}
		item["label"], item["sourceStatus"], item["evidence"] = object(r["request"])["title"], status, Object{"assistanceIds": []any{id}}
	default:
		if _, e := s.Proofs.ReadWithin(ctx, tx, &a.Actor, id, false); e != nil {
			return nil, e
		}
		item["label"], item["sourceStatus"], item["evidence"] = "本人当前 CI 证明；不代替实际经历", "current-ci-proof", Object{"proofIds": []any{id}}
	}
	return item, nil
}
