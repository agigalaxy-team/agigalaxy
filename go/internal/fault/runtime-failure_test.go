package fault

import "testing"

func TestRuntimeFailurePreservesOnlyItsTypedCause(t *testing.T) {
	good := map[string]any{"stage": "model-request", "category": "service-unavailable", "reportedStatus": 502}
	if RuntimeFailure(good)["reportedStatus"] != int64(502) {
		t.Fatal("HTTP cause lost")
	}
	bad := map[string]any{"stage": "model-request", "category": "service-unavailable", "body": "PRIVATE_PROVIDER_BODY"}
	if RuntimeFailure(bad) != nil {
		t.Fatal("provider body accepted as failure metadata")
	}
	bad = map[string]any{"stage": "model-request", "category": "service-unavailable", "reportedStatus": 502.5}
	if RuntimeFailure(bad) != nil {
		t.Fatal("invalid HTTP status accepted")
	}
}
