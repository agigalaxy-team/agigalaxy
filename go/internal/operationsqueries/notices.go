package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
)

func (s *Service) noticeRead(ctx context.Context, service *messaging.Service, actor Actor, args arguments) (queryResult, error) {
	if args.kind == "notice" {
		value, e := service.NoticeGet(ctx, actor, args.id)
		if e != nil {
			return queryResult{}, e
		}
		row := object(value["notice"])
		content, e := messaging.ParseNoticeContent(row["content"])
		if e != nil {
			return queryResult{}, fail("operations_query_response_invalid", 503)
		}
		data := object(project(row, merge(shape("id state createdAt updatedAt expiresAt publishedAt jobId", "s"), Object{"version": "n", "delivery": shape("audienceCount deliveredCount readCount skippedCount pendingCount", "n")})))
		data["content"] = content
		data["contentTrust"] = "untrusted-source"
		data["instructionAuthority"] = "none"
		data["purpose"] = "notice-review"
		return queryResult{source: value, data: data}, nil
	}
	value, e := service.NoticeList(ctx, actor, args.filters)
	if e != nil {
		return queryResult{}, e
	}
	rows := []any{}
	for _, v := range anyArray(value["items"]) {
		row := object(v)
		rows = append(rows, project(row, merge(shape("id state createdAt updatedAt expiresAt", "s"), Object{"version": "n", "delivery": shape("audienceCount deliveredCount pendingCount", "n")})))
	}
	var next any
	if value["nextAfter"] != nil && value["nextAfter"] != "" {
		next = Object{"module": "messaging", "view": "notices", "filters": merge(args.filters, Object{"after": value["nextAfter"]})}
	}
	return queryResult{source: value, data: Object{"items": rows, "coverage": "returned-page"}, pagination: Object{"next": next, "complete": next == nil}}, nil
}
