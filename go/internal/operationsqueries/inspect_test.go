package operationsqueries

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func TestInspectFixedRoutesAndClosedInput(t *testing.T) {
	cases := []Object{
		{"module": "maintenance", "view": "overview", "filters": Object{}},
		{"module": "search", "view": "overview", "filters": Object{"days": 7, "limit": 20}},
		{"module": "recommendations", "view": "overview", "filters": Object{"days": 30}},
		{"module": "analytics", "view": "overview", "filters": Object{"days": 7}},
		{"module": "messaging", "view": "plans", "filters": Object{"limit": 50}},
	}
	for _, input := range cases {
		if _, err := parse("query-operations", input); err != nil {
			t.Fatalf("fixed route %v: %v", input, err)
		}
	}
	_, err := (&Service{}).Query(context.Background(), Actor{}, "overview", "inspect-operations", Object{"scope": "untrusted"})
	if fault.Status(err) != 400 {
		t.Fatalf("nonempty inspect arguments: %v", err)
	}
}

func TestInspectCompletionRequiresPromisedSegmentsNotFullSearchSample(t *testing.T) {
	segments := Object{}
	for _, key := range []string{"workbench", "maintenance", "search", "recommendations", "analytics", "messaging", "autonomy", "delegation"} {
		segments[key] = Object{"availability": "available", "collectionComplete": true}
	}
	object(segments["recommendations"])["profileComplete"] = true
	object(segments["recommendations"])["supplySample"] = Object{"collectionComplete": false}
	object(segments["search"])["querySample"] = Object{"collectionComplete": false, "nextAvailable": true}
	if !inspectionComplete(segments) {
		t.Fatal("bounded search sample must not invalidate complete aggregates")
	}
	object(segments["messaging"])["collectionComplete"] = false
	if inspectionComplete(segments) {
		t.Fatal("incomplete current plan enumeration must remain partial")
	}
	object(segments["messaging"])["collectionComplete"] = true
	delete(segments, "delegation")
	if inspectionComplete(segments) {
		t.Fatal("missing promised segment must remain partial")
	}
}

func TestInspectUnavailableNativeMetricsAreNotComplete(t *testing.T) {
	search := Object{"metrics": Object{"searches": nil}, "configuration": Object{"native": Object{"state": "available"}}, "activeSettings": Object{}}
	if inspectSearchComplete(search) {
		t.Fatal("unknown search count is not complete")
	}
	object(search["metrics"])["searches"] = 0
	if !inspectSearchComplete(search) {
		t.Fatal("observed zero is valid")
	}
	object(object(search["configuration"])["native"])["state"] = "unavailable"
	if inspectSearchComplete(search) {
		t.Fatal("unavailable search native is not complete")
	}
	rec := Object{"basis": Object{"sourceScanComplete": false}, "directionsComplete": true, "metrics": Object{"exposures": nil}}
	if inspectRecommendationsComplete(rec) {
		t.Fatal("unknown recommendation count is not complete")
	}
	object(rec["metrics"])["exposures"] = 0
	if !inspectRecommendationsComplete(rec) {
		t.Fatal("observed zero is valid")
	}
}

func TestInspectMaintenanceRetainsAdoptedQueueScope(t *testing.T) {
	queue := Object{"availability": Object{"state": "available"}, "scope": "adopted-galaxy-river-transport", "includesAllPlatformQueues": false, "items": []any{Object{"name": "messaging-run", "counts": Object{"created": 0, "retry": 0, "active": 0, "completed": 1, "cancelled": 0, "failed": 0}}}}
	components := Object{"complete": true}
	if !inspectMaintenanceComplete(queue, components) {
		t.Fatal("available adopted transport was rejected")
	}
	queue["items"] = nil
	if inspectMaintenanceComplete(queue, components) {
		t.Fatal("missing counts were treated as a complete queue snapshot")
	}
	queue["items"] = []any{}
	components["complete"] = false
	if inspectMaintenanceComplete(queue, components) {
		t.Fatal("incomplete components were accepted")
	}
}
