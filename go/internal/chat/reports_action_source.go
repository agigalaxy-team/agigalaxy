package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
)

// AssertDutyCaseWithin is the original case-purpose check for operation
// reconciliation; it deliberately does not re-read selected source content.
func (s *ReportService) AssertDutyCaseWithin(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, report string) error {
	return s.dutyCase(ctx, tx, a, report)
}

// QualifyActionMessageWithin is the existing private-case prepared-duty source
// check. The actual command still rechecks permission, source and disposition.
func (s *ReportService) QualifyActionMessageWithin(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, report, message string, revision int64, grantID *string) error {
	if e := s.dutyCase(ctx, tx, a, report); e != nil {
		return e
	}
	r, e := s.reportRow(ctx, tx, report, false)
	if e != nil {
		return e
	}
	c, e := s.reportContext(ctx, tx, r, reportCaller{Operator: a, IsOperator: true})
	if e != nil {
		return e
	}
	if !truth(c, "canModerate") || s.expiredReport(r) {
		return fail("operations_agentos_human_review_required", 409)
	}
	mm, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM account_chat_governance_materials_v1 m WHERE report_id=$1 AND message_id=$2 AND revision=$3 AND erased_at IS NULL", report, message, revision)
	if e != nil {
		return e
	}
	if len(mm) == 0 {
		return fail("chat_report_source_unavailable")
	}
	available, e := s.reportSourceAvailable(ctx, tx, mm[0])
	if e != nil {
		return e
	}
	if !available {
		return fail("chat_report_source_unavailable")
	}
	if grantID != nil {
		prior, e := row(ctx, tx, "SELECT to_jsonb(a) FROM (SELECT actor_kind,operator_id,grant_id FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='chat-report-event' AND selection->>'reportId'=$2 AND selection->>'messageId'=$3 ORDER BY sequence DESC LIMIT 1)a", s.Chat.Endpoint, report, message)
		if e != nil {
			return e
		}
		if prior != nil && (str(prior, "actor_kind") != "operations-ai-service" || str(prior, "operator_id") != a.ID || str(prior, "grant_id") != *grantID) {
			return fail("operations_agentos_human_review_required", 409)
		}
	}
	return nil
}
