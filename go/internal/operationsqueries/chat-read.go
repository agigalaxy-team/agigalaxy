package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func chatCaseItem(x Object) Object {
	return object(project(x, merge(shape("reportId state category createdAt updatedAt closedAt", "s"), shape("version materialCount additionalMaterialCapacity", "n"), Object{"materialsExpired": "b", "target": merge(shape("type id", "s"), Object{"version": "n"}), "ownRestriction": Object{"scopes": []any{"s"}, "until": "s"}})))
}
func chatCaseDetail(x Object) (Object, error) {
	materials, ok := x["materials"].([]any)
	if !ok || len(materials) > 20 {
		return nil, fail("operations_query_response_invalid", 503)
	}
	rows := []any{}
	for _, v := range materials {
		item := object(v)
		var text any
		if item["state"] == "available" {
			if _, ok := item["text"].(string); !ok {
				return nil, fail("operations_query_response_invalid", 503)
			}
			text = item["text"]
		}
		files := []any{}
		if attachments, ok := item["attachments"].([]any); ok {
			for _, file := range attachments {
				files = append(files, project(file, merge(shape("attachmentId state mediaType expiresAt", "s"), Object{"size": "n", "contentAvailable": "b"})))
			}
		}
		rows = append(rows, merge(object(project(item, merge(shape("eventId messageId roomId state sourceExpiresAt sentAt", "s"), Object{"revision": "n", "moderation": merge(shape("revision sourceRevision", "n"), shape("hidden ownHidden appliesToCurrent canHide canRestore canKeep", "b"))}))), Object{"text": text, "attachments": files}))
	}
	return merge(chatCaseItem(x), Object{"materials": rows, "material": Object{"purpose": "private-case-review", "trust": "untrusted-source-text", "instructionAuthority": "none", "coverage": "explicit-selected-current-materials"}, "roomHistoryGranted": false}), nil
}
func (s *Service) chatReports(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.ChatReports == nil || s.ChatReports.Admin == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	x := s.ChatReports
	d := x.Admin
	reader := &chat.ReportService{Chat: x.Chat, Attachments: x.Attachments, ReadPrincipalWithin: x.ReadPrincipalWithin, NamesWithin: x.NamesWithin, Admin: &businessadmin.Domain{Pool: d.Pool, Endpoint: d.Endpoint, Authority: s.reader(a), Duty: d.Duty, PrincipalWithin: d.PrincipalWithin, Permissions: d.Permissions, Now: d.Now}}
	if args.kind == "" {
		value, e := reader.OperatorQuery(ctx, a, args.filters)
		if e != nil {
			return queryResult{}, e
		}
		return typedList(args, value, chatCaseItem, fixedKind("chat-report"))
	}
	actor, purpose := a, ""
	if duty := s.Permissions.Duty; duty != nil && duty.AcceptsDuty(a) {
		private, e := postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
			return duty.RequireDutyAction(ctx, tx, a, "chat-reports.materials.read", "prepare")
		})
		if e != nil {
			if fault.Code(e) != "operations_permission_denied" {
				return queryResult{}, e
			}
		} else {
			actor, purpose = private, "private-case-review"
		}
	}
	value, e := reader.OperatorGet(ctx, actor, Object{"reportId": args.id})
	if e != nil {
		return queryResult{}, e
	}
	if purpose != "" {
		_, e = postgres.InTx(ctx, s.Pool, func(tx pgx.Tx) (Actor, error) {
			return s.Permissions.Duty.RequireDutyAction(ctx, tx, actor, "chat-reports.materials.read", "prepare")
		})
		if e != nil {
			return queryResult{}, e
		}
	}
	value, e = queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	data := chatCaseItem(value)
	if purpose != "" {
		data, e = chatCaseDetail(value)
		if e != nil {
			return queryResult{}, e
		}
	}
	return queryResult{source: value, data: data, purpose: purpose, refs: []reference{{kind: "chat-report", id: args.id, row: value, filters: args.filters, purpose: purpose}}}, nil
}
