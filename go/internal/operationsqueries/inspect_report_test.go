package operationsqueries

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestInspectionReportContainsOnlyBoundedOriginalFacts(t *testing.T) {
	segments := Object{}
	for _, key := range inspectionReportKeys {
		segments[key] = Object{"availability": "available", "collectionComplete": true}
	}
	segments["search"] = Object{"availability": "available", "collectionComplete": true, "data": Object{"metrics": Object{"searches": 0, "noResults": 2}, "configuration": Object{"native": Object{"state": "drifted"}}, "queries": Object{"items": []any{Object{"label": "SECRET-SEARCH"}}}, "activeSettings": Object{"secret": "SECRET-SETTINGS"}}, "querySample": Object{"collectionComplete": false, "limit": 20}}
	segments["maintenance"] = Object{"availability": "available", "collectionComplete": true, "data": Object{"componentSummary": Object{"total": 1, "complete": true, "processByState": Object{"failed": 1}, "healthByBasis": []any{Object{"basis": "native-health-endpoint", "unhealthy": 1}}}, "queues": Object{"availability": Object{"state": "available"}, "includesAllPlatformQueues": false, "items": []any{Object{"counts": Object{"created": 0, "retry": 0, "active": 0, "completed": 0, "cancelled": 0, "failed": 3}}}}}}
	segments["delegation"] = Object{"availability": "available", "collectionComplete": true, "targetCount": 1, "targets": []any{Object{"text": "SECRET-PROMPT", "textComplete": true}}}
	result := inspectionReport(Object{"segments": segments, "checkedAt": 2000000000, "profileComplete": true})
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > 8192 {
		t.Fatalf("report size/encoding: %d %v", len(encoded), err)
	}
	if strings.Contains(string(encoded), "SECRET-") {
		t.Fatal("private source material copied into report")
	}
	sections := object(result["sections"])
	metrics := object(object(object(sections["search"])["facts"])["metrics"])
	if object(object(sections["search"])["facts"])["nativeState"] != "drifted" {
		t.Fatal("native drift state was lost")
	}
	if metrics["searches"] == nil || metrics["measuredSearches"] != nil {
		t.Fatal("observed zero or unknown was changed")
	}
	maintenance := object(sections["maintenance"])
	if object(maintenance["coverage"])["includesAllPlatformQueues"] != false {
		t.Fatal("source queue scope changed")
	}
	found := anyArray(maintenance["findingCodes"])
	if len(found) != 3 {
		t.Fatalf("original findings missing: %v", found)
	}
	delegation := object(object(sections["delegation"])["facts"])
	if delegation["targetCount"] == nil || delegation["promptsRead"] != 1 {
		t.Fatal("delegation counts absent")
	}
}
