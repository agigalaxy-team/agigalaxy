package moderation

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/opportunities"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/jackc/pgx/v5"
)

func (s *Service) visibleReports(ctx context.Context, tx pgx.Tx, a Actor, caseID, assistance, after string, limit int) ([]Object, error) {
	visible := []Object{}
	scanned := nullable(after)
	for len(visible) < limit {
		candidates, e := rows(ctx, tx, `SELECT to_jsonb(r) FROM (SELECT r.id FROM moderation_reports r WHERE ($1::uuid IS NULL OR r.case_id=$1) AND ($2::uuid IS NULL OR r.assistance_id=$2) AND ($3::uuid IS NULL OR r.id>$3) AND ($4::boolean OR r.reporter_id=$5::text OR r.participant_ids ? $5::text OR EXISTS(SELECT 1 FROM moderation_events e LEFT JOIN consents c ON c.id=e.consent_id WHERE e.report_id=r.id AND (e.subject_id=$5::text OR c.intent->'viewers' ? $5::text))) ORDER BY r.id LIMIT 100)r`, nullable(caseID), nullable(assistance), scanned, s.isModerator(a.Device.SubjectID), a.Device.SubjectID)
		if e != nil {
			return nil, e
		}
		for _, candidate := range candidates {
			r, e := s.load(ctx, tx, str(candidate, "id"), false)
			if e != nil {
				return nil, e
			}
			if r != nil && s.allowed(a.Device.SubjectID, r) {
				visible = append(visible, r)
				if len(visible) == limit {
					break
				}
			}
		}
		if len(visible) == limit || len(candidates) < 100 {
			break
		}
		scanned = candidates[len(candidates)-1]["id"]
	}
	return visible, nil
}
func (s *Service) Query(ctx context.Context, a Actor, raw []byte) (Object, error) {
	var q Object
	if protocol.Decode(raw, &q) != nil || q == nil || !strict(q, "assistanceId", "caseId", "after", "limit") {
		return nil, fail("invalid_moderation_query", 409)
	}
	for _, k := range []string{"assistanceId", "caseId", "after"} {
		if _, ok := q[k]; ok && !opportunities.UUID.MatchString(str(q, k)) {
			return nil, fail("invalid_moderation_query", 409)
		}
	}
	if q["caseId"] != nil && q["assistanceId"] != nil {
		return nil, fail("invalid_moderation_query", 409)
	}
	if _, ok := q["limit"]; !ok {
		q["limit"] = 8
	}
	limit, ok := integer(q["limit"], 1, 20)
	if !ok {
		return nil, fail("invalid_moderation_query", 409)
	}
	return s.run(ctx, a, false, false, func(tx pgx.Tx, _ deviceauth.ControlAuthorization) (Object, error) {
		rr, e := s.visibleReports(ctx, tx, a, str(q, "caseId"), str(q, "assistanceId"), str(q, "after"), int(limit)+1)
		if e != nil {
			return nil, e
		}
		n := len(rr)
		if n > int(limit) {
			n = int(limit)
		}
		items := []Object{}
		for _, r := range rr[:n] {
			v := Object{"reportId": r["id"], "version": r["version"], "state": r["state"], "paused": r["paused"]}
			if r["case_id"] != nil {
				v["caseId"] = r["case_id"]
			} else {
				v["assistanceId"] = r["assistance_id"]
			}
			items = append(items, v)
		}
		var after any
		if len(rr) > int(limit) {
			after = rr[int(limit)-1]["id"]
		}
		return Object{"items": items, "nextAfter": after}, nil
	})
}

// CaseContextWithin is the original current Case consumer. Its actor has
// already been authenticated by the owning Case read, without a new scope.
func (s *Service) CaseContextWithin(ctx context.Context, tx pgx.Tx, a *deviceauth.Actor, id string) (Object, error) {
	context := Object{"version": 1, "authority": "viewer-authorized-moderation", "automaticallyVerified": false, "items": []Object{}, "coverage": "up-to-20-visible-reports; latest-10-visible-events-per-report"}
	if a == nil {
		return context, nil
	}
	if _, e := s.caseSource(ctx, tx, a.SubjectID, id, false); e != nil {
		if serviceError(e) {
			return context, nil
		}
		return nil, e
	}
	rr, e := s.visibleReports(ctx, tx, Actor{Device: a}, id, "", "", 20)
	if e != nil {
		return nil, e
	}
	items := []Object{}
	for _, r := range rr {
		record, e := s.ReadWithin(ctx, tx, Actor{Device: a}, str(r, "id"), r)
		if e != nil {
			return nil, e
		}
		events := objectsOf(record["events"])
		if len(events) > 10 {
			events = events[len(events)-10:]
		}
		var source any
		if current := obj(record, "source"); current != nil {
			source = Object{"reportedVersion": current["reportedVersion"], "currentVersion": current["currentVersion"], "targetEventId": current["targetEventId"]}
		}
		items = append(items, Object{"reportId": record["reportId"], "version": record["version"], "state": record["state"], "paused": record["paused"], "report": record["report"], "events": events, "revalidation": record["revalidation"], "source": source})
	}
	context["items"] = items
	return context, nil
}
