package operationsautonomy

import (
	"context"
	"strings"
	"testing"
)

func syntheticInspectionReport() Object {
	sections := Object{}
	for key, scope := range inspectionSections {
		sections[key] = Object{"availability": "available", "complete": true, "scope": scope, "window": Object{"requestedDays": nil, "from": nil, "to": nil}, "coverage": Object{}, "facts": Object{}, "findingCodes": []any{}}
	}
	obj(obj(sections["maintenance"])["facts"])["componentTotal"] = float64(5)
	obj(obj(sections["search"])["facts"])["private"] = "MUST_NOT_PERSIST"
	obj(obj(sections["workbench"])["facts"])["counts"] = Object{"feedback": Object{"total": float64(3), "pending": nil}, "search": Object{"failed": float64(2)}}
	return Object{"schemaVersion": float64(1), "profile": "current-operations-v1", "checkedAt": float64(2000000000), "profileComplete": true, "sections": sections, "prompt": "MUST_NOT_PERSIST"}
}

func TestInspectionReportClosedProjectionAndCurrentPermissions(t *testing.T) {
	report := inspectionReport(syntheticInspectionReport())
	if report == nil || strings.Contains(jsonText(report), "MUST_NOT_PERSIST") {
		t.Fatalf("unsafe report %#v", report)
	}
	sections := obj(report["sections"])
	if obj(obj(sections["maintenance"])["facts"])["componentTotal"] != float64(5) {
		t.Fatal("real count dropped")
	}
	counts := obj(obj(obj(sections["workbench"])["facts"])["counts"])
	if obj(counts["feedback"])["pending"] != nil {
		t.Fatal("missing count became non-null")
	}
	authority := &originalReadAuthority{denied: "maintenance.read"}
	s := &Service{Authority: authority, Endpoint: "https://original-receipt.invalid"}
	s.filterInspectionReportWithin(context.Background(), nil, Actor{ID: "human", Endpoint: s.Endpoint}, report)
	maintenance := obj(sections["maintenance"])
	if maintenance["availability"] != "not-authorized" || maintenance["facts"] != nil || maintenance["window"] != nil || report["accessComplete"] != false {
		t.Fatalf("revoked data exposed %#v", maintenance)
	}
	report = inspectionReport(syntheticInspectionReport())
	authority.denied = "feedback.read"
	s.filterInspectionReportWithin(context.Background(), nil, Actor{ID: "human", Endpoint: s.Endpoint}, report)
	counts = obj(obj(obj(obj(report["sections"])["workbench"])["facts"])["counts"])
	if counts["feedback"] != nil || obj(counts["search"])["failed"] != float64(2) || report["accessComplete"] != false {
		t.Fatalf("workbench block exposed or over-redacted %#v", counts)
	}
}
