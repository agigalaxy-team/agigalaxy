package operationsqueries

import (
	"strings"
	"testing"
)

func TestCleanupCandidateAndFileVersionNeverTruncate(t *testing.T) {
	token := "[\"processing\",1]"
	candidate := cleanupCandidateItem(Object{"expectedVersion": token})
	if candidate["expectedVersion"] != token {
		t.Fatal("expected exact candidate token")
	}
	candidate = cleanupCandidateItem(Object{"expectedVersion": strings.Repeat("界", 4097)})
	if candidate["expectedVersion"] != nil || candidate["expectedVersionUnavailable"] != true {
		t.Fatal("oversized candidate token must be unavailable")
	}
	file := fileItem(Object{"version": token, "processingVersion": token})
	if file["processingVersion"] != token {
		t.Fatal("expected exact processing token")
	}
	file = fileItem(Object{"version": strings.Repeat("界", 4097), "processingVersion": strings.Repeat("界", 4097)})
	if file["processingVersion"] != nil || file["version"] != nil || file["processingVersionUnavailable"] != true {
		t.Fatal("oversized token must not be offered as CAS")
	}
}
