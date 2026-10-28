package targetgovernance

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/jackc/pgx/v5"
)

func (s *Service) NotificationReadWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, candidate Object) (Object, error) {
	return s.NotificationViewWithin(ctx, tx, a, str(candidate, "event_id"))
}

// NotificationViewWithin retains only the original currently visible handling
// state. It does not disclose a private report to every affected room member.
func (s *Service) NotificationViewWithin(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, eventID string) (Object, error) {
	if _, e := s.Devices.CurrentControlWithin(ctx, tx, a, "notifications"); e != nil {
		return nil, e
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(e)||jsonb_build_object('party_ids',r.party_ids) FROM target_governance_events_v2 e JOIN target_reports_v2 r ON r.id=e.report_id WHERE e.id=$1", eventID)
	if e != nil || r == nil {
		return nil, e
	}
	scoped := *s
	scoped.accountScope = "notifications"
	report, e := scoped.ReadWithin(ctx, tx, Actor{Device: &a}, str(r, "report_id"))
	if e != nil {
		if missing(e) {
			return nil, nil
		}
		return nil, e
	}
	visible := false
	for _, v := range report["events"].([]Object) {
		visible = visible || v["eventId"] == eventID
	}
	necessary := has([]string{"review", "pause", "resolve", "resume", "appeal", "withdraw-report"}, str(r, "kind")) && has(stringsOf(r["party_ids"]), a.SubjectID)
	if !visible && !necessary {
		return nil, nil
	}
	return Object{"actorId": r["subject_id"], "eventKind": "target-governance-" + str(r, "kind"), "title": "任务或房间处理状态有更新", "object": Object{"type": "target-governance", "id": r["report_id"], "eventId": eventID, "target": report["target"], "state": report["state"]}, "serviceReceipt": true, "sourceExpiresAt": stamp(seconds(r["created_at"]) + 90*86400).Format("2006-01-02T15:04:05.000Z")}, nil
}

// CleanupRetentionWithin is the original bounded worker cleanup. It never
// deletes chat archive content or an unexpired operational restriction.
func (s *Service) CleanupRetentionWithin(ctx context.Context, tx pgx.Tx, now int64) (Object, error) {
	rr, e := rows(ctx, tx, "SELECT to_jsonb(r) FROM (SELECT id FROM target_reports_v2 WHERE closed_at<=$1 AND (restriction_until IS NULL OR restriction_until<=$2) ORDER BY closed_at,id LIMIT 100 FOR UPDATE)r", stamp(now-180*86400), stamp(now))
	if e != nil {
		return nil, e
	}
	if len(rr) == 0 {
		return Object{"targetReports": 0, "targetGovernanceEvents": 0}, nil
	}
	ids := []string{}
	for _, r := range rr {
		ids = append(ids, str(r, "id"))
	}
	if _, e = tx.Exec(ctx, "UPDATE target_reports_v2 SET restriction_event_id=NULL,decision_event_id=NULL WHERE id=ANY($1::uuid[])", ids); e != nil {
		return nil, e
	}
	events, e := tx.Exec(ctx, "DELETE FROM target_governance_events_v2 WHERE report_id=ANY($1::uuid[])", ids)
	if e != nil {
		return nil, e
	}
	reports, e := tx.Exec(ctx, "DELETE FROM target_reports_v2 WHERE id=ANY($1::uuid[])", ids)
	if e != nil {
		return nil, e
	}
	return Object{"targetReports": reports.RowsAffected(), "targetGovernanceEvents": events.RowsAffected()}, nil
}
