package discovery

import (
	"context"
	"github.com/google/uuid"
)

func (q *SearchQuality) PublicPlan(ctx context.Context) (Object, error) {
	state, e := q.state(ctx, q.Pool)
	if e != nil {
		return nil, e
	}
	if state["pending_operation"] != nil {
		if _, e = q.Reconcile(ctx, str(state, "pending_operation")); e != nil {
			return nil, e
		}
	}
	native, e := q.observedSettings(ctx)
	if e != nil {
		return nil, e
	}
	current, e := q.state(ctx, q.Pool)
	if e != nil {
		return nil, e
	}
	active, e := q.version(ctx, q.Pool, str(current, "active_id"))
	if e != nil {
		return nil, e
	}
	if active != nil && current["pending_operation"] == nil && sameNative(native, object(active["native_settings"])) {
		return Object{"version": active["version"], "rankingMode": object(active["settings"])["rankingMode"]}, nil
	}
	return Object{"version": nil, "rankingMode": nil}, nil
}
func (q *SearchQuality) IssueSearch(ctx context.Context, profile string, request SearchRequest, result, plan Object) (Object, error) {
	id := uuid.NewString()
	items, _ := result["items"].([]Object)
	state := "no-results"
	if len(items) > 0 {
		state = "has-results"
	} else if request.After > 0 || result["scanLimited"] == true || result["nextAfter"] != nil {
		state = "scan-limited"
	}
	projections := []Object{}
	for i, item := range items {
		projections = append(projections, Object{"kind": item["kind"], "id": item["id"], "sourceVersion": item["version"], "position": i + 1})
	}
	_, e := q.Pool.Exec(ctx, `INSERT INTO discovery_search_requests_v1(endpoint,id,profile_id,query,configuration_version,source_offset,result_state,items,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, q.Endpoint, id, profile, request.Query, plan["version"], request.After, state, jsonString(projections), q.now())
	if e != nil {
		return nil, e
	}
	return Object{"requestId": id, "configurationVersion": plan["version"], "resultState": state, "sourceOffset": request.After}, nil
}
func (q *SearchQuality) Evidence(ctx context.Context, profile string, event Object) (Object, error) {
	search := object(event["search"])
	row, e := rowObject(ctx, q.Pool, "SELECT to_jsonb(s) FROM discovery_search_requests_v1 s WHERE endpoint=$1 AND id=$2 AND profile_id=$3", q.Endpoint, search["requestId"], profile)
	if e != nil {
		return nil, e
	}
	if row == nil || str(event, "name") == "search" && (number(row, "source_offset") != 0 || normalizeTerm(str(event, "query")) != normalizeTerm(str(row, "query"))) {
		return nil, qualityFailure("discovery_search_reference_invalid", 403)
	}
	var selected Object
	if content := object(event["content"]); content != nil {
		items, _ := row["items"].([]any)
		for _, value := range items {
			item := object(value)
			if item["kind"] == content["kind"] && item["id"] == content["id"] && item["sourceVersion"] == content["version"] {
				selected = item
				break
			}
		}
		if selected == nil {
			return nil, qualityFailure("discovery_search_reference_invalid", 403)
		}
	}
	result := Object{"requestId": row["id"], "query": row["query"], "configurationVersion": row["configuration_version"], "resultState": row["result_state"], "sourceOffset": row["source_offset"]}
	if selected != nil {
		result["position"] = selected["position"]
	}
	return result, nil
}
