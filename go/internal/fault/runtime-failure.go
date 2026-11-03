package fault

import "math"

// RuntimeFailure projects the shared, body-free failure contract used by
// task receipts and native run metadata. Provider prose is never an input field.
func RuntimeFailure(value any) map[string]any {
	f, ok := value.(map[string]any)
	if !ok || len(f) != 3 {
		return nil
	}
	if _, exists := f["reportedStatus"]; !exists {
		return nil
	}
	stage, category := f["stage"], f["category"]
	if stage != "model-request" && stage != "execution" {
		return nil
	}
	switch category {
	case "rate-limit", "timeout", "connection", "context-limit", "service-unavailable", "request-rejected", "unknown":
	default:
		return nil
	}
	var status any
	if raw := f["reportedStatus"]; raw != nil {
		var n float64
		switch v := raw.(type) {
		case int:
			n = float64(v)
		case int64:
			n = float64(v)
		case float64:
			n = v
		default:
			return nil
		}
		if math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < 400 || n > 599 {
			return nil
		}
		status = int64(n)
	}
	return map[string]any{"stage": stage, "category": category, "reportedStatus": status}
}
