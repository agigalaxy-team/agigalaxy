package operationsautonomy

// inspectionOutcome keeps only fixed profile status, never source data or text.
func inspectionOutcome(result Object) Object {
	if result["profile"] != "current-operations-v1" {
		return nil
	}
	segments := obj(result["segments"])
	projected := Object{}
	complete := result["inspectionChecked"] == true && result["profileComplete"] == true
	for _, key := range []string{"workbench", "maintenance", "search", "recommendations", "analytics", "messaging", "autonomy", "delegation"} {
		segment := obj(segments[key])
		availability := str(segment["availability"])
		if !has([]string{"available", "partial", "unavailable", "not-authorized"}, availability) {
			availability = "unknown"
		}
		segmentComplete := segment["collectionComplete"] == true
		if key == "recommendations" {
			segmentComplete = segment["profileComplete"] == true
		}
		reason := "complete"
		switch {
		case segment == nil:
			reason = "unknown"
		case availability == "not-authorized":
			reason = "not-authorized"
		case availability == "unavailable":
			reason = "unavailable"
		case segment["sourceWithheld"] == true:
			reason = "source-withheld"
		case availability != "available" || !segmentComplete:
			reason = "incomplete"
		}
		if reason != "complete" {
			complete = false
		}
		projected[key] = Object{"availability": availability, "profileComplete": segmentComplete && availability == "available", "reason": reason}
	}
	out := Object{"profile": "current-operations-v1", "profileComplete": complete, "segments": projected}
	if report := inspectionReport(result["inspectionReport"]); report != nil {
		if !complete {
			report["profileComplete"] = false
		}
		out["inspectionReport"] = report
	}
	return out
}
