package operationsqueries

import (
	"context"
	"time"
)

func runTime(v any) any {
	if n, ok := number(v); ok && n >= 0 {
		return n
	}
	if s, ok := v.(string); ok {
		if _, e := time.Parse(time.RFC3339Nano, s); e == nil {
			return s
		}
	}
	return nil
}
func aiRunItem(x Object) Object {
	return merge(object(project(x, merge(shape("runId domain state errorCode promptVersion", "s"), Object{"durationMs": "n", "tokens": shape("input output total", "n"), "conversation": Object{"operatorDisplayName": "s"}, "executor": shape("kind mode onBehalfOfDisplayName", "s")}))), Object{"createdAt": runTime(x["createdAt"]), "updatedAt": runTime(x["updatedAt"])})
}
func spanItem(x Object) Object {
	return merge(object(project(x, merge(shape("spanId parentSpanId kind state", "s"), Object{"durationMs": "n", "tokens": shape("input output total", "n")}))), Object{"startTime": runTime(x["startTime"]), "endTime": runTime(x["endTime"])})
}
func (s *Service) runtimeRead(ctx context.Context, a Actor, args arguments) (queryResult, error) {
	if args.module == "jobs" {
		if s.Jobs == nil {
			return queryResult{}, fail("operations_query_not_configured", 503)
		}
		filters := merge(args.filters)
		queue := str(filters["queue"])
		delete(filters, "queue")
		value, e := s.Jobs.QueryRead(ctx, a, s.reader(a), queue, filters)
		if e != nil {
			return queryResult{}, e
		}
		return typedList(args, value, func(x Object) Object {
			out := object(project(x, merge(shape("id queue state createdAt startedAt completedAt availableAt resourceId", "s"), shape("retryCount retryLimit", "n"))))
			out["error"] = safeCode(x["error"])
			return out
		}, nil)
	}
	if s.Runs == nil {
		return queryResult{}, fail("operations_query_not_configured", 503)
	}
	view := args.view
	if args.kind == "ai-run" {
		view = args.kind
	}
	value, e := s.Runs.QueryRead(ctx, a, s.reader(a), view, args.id, args.filters)
	if e != nil {
		return queryResult{}, e
	}
	value, e = queryWireSource(value)
	if e != nil {
		return queryResult{}, e
	}
	if args.kind == "ai-run" {
		row := object(value["run"])
		spans := []any{}
		if items, ok := value["spans"].([]any); ok {
			for _, x := range items {
				spans = append(spans, spanItem(object(x)))
			}
		}
		return queryResult{source: value, data: Object{"run": aiRunItem(row), "spans": spans}, refs: []reference{{kind: "ai-run", id: args.id, row: row, filters: args.filters}}}, nil
	}
	out, e := typedList(args, value, aiRunItem, func(x Object) string { return "ai-run" })
	if e != nil {
		return queryResult{}, e
	}
	var next any
	if page := value["nextPage"]; page != nil && page != false {
		if n, ok := number(page); !ok || n != 0 {
			next = Object{"module": args.module, "view": args.view, "filters": merge(args.filters, Object{"page": page})}
		}
	}
	out.pagination = Object{"next": next, "complete": next == nil}
	out.data["total"] = project(value["total"], "n")
	return out, nil
}
