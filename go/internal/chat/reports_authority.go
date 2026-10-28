package chat

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationspermissions"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

type ReportService struct {
	Chat                *Service
	Attachments         *AttachmentService
	Admin               *businessadmin.Domain
	ReadPrincipalWithin func(context.Context, pgx.Tx, operationspermissions.Actor) (map[string]string, error)
	NamesWithin         func(context.Context, pgx.Tx, []string) (map[string]string, error)
}
type reportCaller struct {
	Account    Actor
	Operator   operationspermissions.Actor
	IsOperator bool
}

func (s *ReportService) admin() *businessadmin.Domain {
	if s.Admin == nil {
		return nil
	}
	d := *s.Admin
	d.Permissions = func(action string, x Object) []string {
		switch action {
		case "chat-report-event":
			if has([]string{"message-hide", "message-restore", "message-keep"}, str(x, "kind")) {
				return []string{"chat-messages." + str(x, "kind")[8:]}
			}
			return []string{"chat-reports.moderate"}
		case "chat-report-attachment":
			return []string{"chat-reports.attachments.read"}
		default:
			return []string{"chat-reports.read"}
		}
	}
	return &d
}
func (s *ReportService) Configuration() Object {
	return Object{"categories": reportCategories, "maxMaterials": 20, "maxAttachmentsPerMessage": 16, "maxSummaryLength": 1600, "materialDisclosure": "explicitly-selected-messages-and-attachments", "roomHistoryGranted": false}
}
func (s *ReportService) run(ctx context.Context, a Actor, write bool, fn func(pgx.Tx) (Object, error)) (Object, error) {
	if a.Device != nil || a.AccountID == "" {
		return nil, fail("chat_report_account_required", 401)
	}
	return s.Chat.run(ctx, a, write, true, fn)
}
func (s *ReportService) reportRow(ctx context.Context, tx pgx.Tx, id string, write bool) (Object, error) {
	lock := " FOR SHARE"
	if write {
		lock = " FOR UPDATE"
	}
	r, e := row(ctx, tx, "SELECT to_jsonb(r) FROM account_chat_reports_v1 r WHERE id=$1 AND endpoint=$2"+lock, id, s.Chat.Endpoint)
	if e == nil && r == nil {
		e = fail("chat_report_unavailable", 404)
	}
	return r, e
}
func (s *ReportService) expiredReport(r Object) bool {
	return r["closed_at"] != nil && millis(r["closed_at"])+180*86400000 <= s.Chat.now().UnixMilli()
}
func (s *ReportService) currentReportTarget(ctx context.Context, tx pgx.Tx, r Object) (Object, error) {
	v, e := row(ctx, tx, "SELECT to_jsonb(r) FROM (SELECT room_id,revision,state FROM chat_rooms WHERE room_id=$1 FOR SHARE)r", r["room_id"])
	if e != nil || v == nil {
		return nil, e
	}
	return Object{"type": "room", "id": v["room_id"], "version": v["revision"], "state": v["state"]}, nil
}
func (s *ReportService) dutyCase(ctx context.Context, tx pgx.Tx, a operationspermissions.Actor, id string) error {
	d := s.admin()
	authority := d.DutyAuthority()
	if authority == nil || !authority.AcceptsDuty(a) {
		return fail("business_admin_denied", 403)
	}
	a, e := authority.RequireDutyAction(ctx, tx, a, "chat-reports.materials.read", "prepare")
	if e != nil {
		return e
	}
	m, e := authority.DutyMetadata(a)
	if e != nil {
		return e
	}
	c := obj(m, "context")
	if c == nil {
		c = m
	}
	task, e := row(ctx, tx, "SELECT jsonb_build_object('type',target_type,'id',target_id) FROM operations_autonomy_tasks_v1 WHERE endpoint=$1 AND id=$2 FOR SHARE", s.Chat.Endpoint, c["taskId"])
	if e != nil {
		return e
	}
	if !(str(task, "type") == "chat-report" && str(task, "id") == id) && !has(reportStrings(c["resourceIds"]), id) {
		return fail("operations_ai_case_purpose_denied", 403)
	}
	return nil
}
func (s *ReportService) independent(ctx context.Context, tx pgx.Tx, r Object, a operationspermissions.Actor) (bool, error) {
	if _, e := tx.Exec(ctx, "SELECT room_id FROM chat_rooms WHERE room_id=$1 FOR SHARE", r["room_id"]); e != nil {
		return false, e
	}
	mm, e := rows(ctx, tx, "SELECT to_jsonb(m) FROM (SELECT subject_id,controller_ref FROM chat_memberships WHERE room_id=$1 AND left_at IS NULL)m", r["room_id"])
	if e != nil {
		return false, e
	}
	refs := reportStrings(r["party_refs"])
	for _, m := range mm {
		refs = append(refs, str(m, "subject_id"), str(m, "controller_ref"))
	}
	subjects, accounts := []string{}, []string{str(r, "reporter_account_id")}
	for _, v := range refs {
		if strings.HasPrefix(v, "subject:") && subjectPattern.MatchString(strings.TrimPrefix(v, "subject:")) {
			subjects = append(subjects, strings.TrimPrefix(v, "subject:"))
		} else if subjectPattern.MatchString(v) {
			subjects = append(subjects, v)
		} else if accountPattern.MatchString(v) {
			accounts = append(accounts, v[8:])
		}
	}
	if e = accountlinks.LockMappingsWithin(ctx, tx, s.Chat.Endpoint, subjects, false); e != nil {
		return false, e
	}
	d := s.admin()
	if d.IsDuty(a) || d.IsExecution(a) {
		return true, d.Principal(ctx, tx, a)
	}
	if s.ReadPrincipalWithin == nil || s.Chat.Links == nil {
		return false, fail("operations_authorization_unavailable", 503)
	}
	p, e := s.ReadPrincipalWithin(ctx, tx, a)
	if e != nil {
		return false, e
	}
	conflict, e := s.Chat.Links.OpsPartyConflictWithin(ctx, tx, p["issuer"], p["externalSubject"], subjects, accounts)
	return !conflict, e
}
func (s *ReportService) reportContext(ctx context.Context, tx pgx.Tx, r Object, a reportCaller) (Object, error) {
	if a.IsOperator {
		d := s.admin()
		if d == nil || d.Authority == nil {
			return nil, fail("business_admin_unavailable", 503)
		}
		fresh, e := d.Authority.EffectiveWithin(ctx, tx, a.Operator)
		if e != nil {
			return nil, e
		}
		ind, e := s.independent(ctx, tx, r, fresh)
		if e != nil {
			return nil, e
		}
		if d.IsDuty(fresh) && has(fresh.Permissions, "chat-reports.materials.read") {
			if e = s.dutyCase(ctx, tx, fresh, str(r, "id")); e != nil {
				return nil, e
			}
		}
		moderate := false
		for _, p := range []string{"chat-reports.moderate", "chat-messages.hide", "chat-messages.restore", "chat-messages.keep"} {
			moderate = moderate || has(fresh.Permissions, p)
		}
		return Object{"operator": true, "independent": ind, "reporter": false, "party": !ind, "permissions": fresh.Permissions, "canReadMaterials": has(fresh.Permissions, "chat-reports.materials.read"), "canReadAttachments": has(fresh.Permissions, "chat-reports.attachments.read"), "canManageCase": ind && has(fresh.Permissions, "chat-reports.moderate"), "canModerate": ind && moderate}, nil
	}
	ref, _ := actorRef(a.Account)
	party := str(r, "reporter_account_id") == a.Account.AccountID || has(reportStrings(r["party_refs"]), ref)
	if !party {
		if e := tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM chat_memberships WHERE room_id=$1 AND subject_id=$2 AND left_at IS NULL)", r["room_id"], ref).Scan(&party); e != nil {
			return nil, e
		}
	}
	if !party {
		return nil, fail("chat_report_unavailable", 404)
	}
	return Object{"operator": false, "independent": false, "reporter": str(r, "reporter_account_id") == a.Account.AccountID, "party": party, "canModerate": false}, nil
}
func reportStamp(sec int64) time.Time { return time.Unix(sec, 0) }

func reportDate(v any) any {
	if v == nil {
		return nil
	}
	if t, ok := v.(time.Time); ok {
		return t
	}
	t, e := time.Parse(time.RFC3339Nano, asString(v))
	if e != nil {
		return nil
	}
	return t
}
