package operationsqueries

import "testing"

func TestSearchOutcomeAndMaintenanceEvidenceFacts(t *testing.T) {
	metrics := Object{"resultKnownSearches": 1385, "noResults": 26, "measuredSearches": 1400, "scanLimited": 15}
	facts := searchOutcomeFacts(metrics)
	if facts["state"] != "available" || facts["withResultsCount"] != float64(1359) {
		t.Fatalf("known includes empty: %v", facts)
	}
	zero := searchOutcomeFacts(Object{"resultKnownSearches": 0, "noResults": 0, "measuredSearches": 0, "scanLimited": 0})
	if zero["state"] != "available" || zero["withResultsCount"] != float64(0) {
		t.Fatalf("observed zero: %v", zero)
	}
	missing := searchOutcomeFacts(Object{"resultKnownSearches": 2, "measuredSearches": 3, "scanLimited": 0})
	if missing["state"] != "unknown" || missing["withResultsCount"] != nil {
		t.Fatal("missing result inferred")
	}
	bad := searchOutcomeFacts(Object{"resultKnownSearches": 2, "noResults": 3, "measuredSearches": 3, "scanLimited": 0})
	if bad["state"] != "inconsistent" || bad["withResultsCount"] != nil {
		t.Fatal("contradictory result inferred")
	}
	bad = searchOutcomeFacts(Object{"resultKnownSearches": 3, "noResults": 1, "measuredSearches": 3, "scanLimited": 1})
	if bad["state"] != "inconsistent" || bad["withResultsCount"] != nil {
		t.Fatal("contradictory scan-limited count inferred")
	}
	summary := object(maintenanceProjection(Object{"components": []any{Object{"processState": "running", "processAvailability": Object{"state": "available"}, "healthBasis": "not-connected", "healthAvailability": Object{"state": "not-configured"}}}})["componentSummary"])
	meaning := object(summary["evidenceMeaning"])
	if meaning["configurationRationale"] != "not-reported" || meaning["runningImpliesHealthy"] != false || meaning["unconfiguredImpliesHealthy"] != false {
		t.Fatal("invented health evidence")
	}
	group := object(anyArray(summary["healthByBasis"])[0])
	if group["healthy"] != 0 || group["unknown"] != float64(1) || group["notConfigured"] != float64(1) {
		t.Fatalf("unknown health changed: %v", group)
	}
}
