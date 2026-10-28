package operationsqueries

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/feedback"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"strconv"
)

func feedbackItem(x Object) Object {
	return object(project(x, merge(shape("id category module state createdAt updatedAt", "s"), shape("revision attachmentCount", "n"), Object{"account": accountShape})))
}
func feedbackDetail(x Object) (Object, error) {
	title, ok := x["title"].(string)
	body, valid := x["body"].(string)
	if !ok || !valid || protocol.TextLength(title) < 1 || protocol.TextLength(title) > 120 || protocol.TextLength(body) < 1 || protocol.TextLength(body) > 6000 {
		return nil, fail("operations_query_response_invalid", 503)
	}
	return merge(feedbackItem(x), Object{"title": title, "body": body, "titleTruncated": false, "bodyTruncated": false, "material": Object{"purpose": "feedback-processing", "trust": "untrusted-source-text", "instructionAuthority": "none", "coverage": "complete"}}), nil
}
func (s *Service) feedback(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if s.Feedback == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	source := s.Feedback.WithAuthority(s.reader(a))
	if source == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	if args.kind != "" {
		value, e := source.Get(ctx, a, args.id, "")
		if e != nil {
			return queryResult{}, e
		}
		value, e = queryWireSource(value)
		if e != nil {
			return queryResult{}, e
		}
		row := object(value["feedback"])
		if row["id"] != args.id {
			return queryResult{}, fail("operations_query_response_invalid", 503)
		}
		data, e := feedbackDetail(row)
		if e != nil {
			return queryResult{}, e
		}
		return queryResult{source: value, data: data, purpose: "feedback-processing", refs: []reference{{kind: "feedback", id: args.id, row: row, filters: args.filters, purpose: "feedback-processing"}}}, nil
	}
	q := feedback.Query{Query: "", Category: str(args.filters["category"]), Module: str(args.filters["module"]), State: str(args.filters["state"]), After: str(args.filters["after"])}
	if days, ok := args.filters["days"]; ok {
		if days == "all" {
			q.Days = "all"
		} else if n, ok := number(days); ok {
			q.Days = strconv.FormatInt(int64(n), 10)
		}
	}
	if limit, ok := number(args.filters["limit"]); ok {
		q.Limit = int(limit)
	}
	value, e := source.List(ctx, a, q)
	if e != nil {
		return queryResult{}, e
	}
	value, e = queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	result, e := typedList(args, value, feedbackItem, fixedKind("feedback"))
	if e != nil {
		return queryResult{}, e
	}
	result.data["summary"] = project(value["summary"], merge(shape("total unclassified pending closed", "n"), Object{"byCategory": []any{Object{"category": "s", "count": "n"}}}))
	return result, nil
}
