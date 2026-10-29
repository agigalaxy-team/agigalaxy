package actions

import (
	"strings"
	"testing"
)

func TestSearchReviewIncludesBothCompleteSettings(t *testing.T) {
	constraints := Object{"currentSource": true, "anonymousPublic": true, "withdrawnExcluded": true, "expiredExcluded": true}
	before := Object{"synonyms": []any{Object{"term": "one", "alternatives": []any{"first"}}}, "rankingMode": "relevance", "fixedConstraints": constraints}
	after := Object{"synonyms": []any{Object{"term": "two", "alternatives": []any{"second"}}}, "rankingMode": "newest", "fixedConstraints": constraints}
	p := preparation{}
	if err := searchReview(&p, before, after, "保存"); err != nil {
		t.Fatal(err)
	}
	lines := []string{}
	for _, value := range p.impact {
		lines = append(lines, str(value))
	}
	joined := strings.Join(lines, "\n")
	for _, value := range []string{"one", "first", "relevance", "two", "second", "newest"} {
		if !strings.Contains(joined, value) {
			t.Fatalf("review omitted %s", value)
		}
	}
}

func TestSearchDraftRequestRejectsChangedDraftBinding(t *testing.T) {
	constraints := Object{"currentSource": true, "anonymousPublic": true, "withdrawnExcluded": true, "expiredExcluded": true}
	request, err := ParseRequest(Object{"kind": "search-draft-save", "reason": "save", "settings": Object{"synonyms": []any{}, "rankingMode": "relevance", "fixedConstraints": constraints}})
	if err != nil {
		t.Fatal(err)
	}
	command := Object{"operationId": "11111111-1111-4111-8111-111111111111", "expectedRevision": 0, "reason": "save", "settings": request["settings"], "expectedDraftId": nil}
	if _, err = normalizeDiscoveryCommand(request, command, nil); err != nil {
		t.Fatal(err)
	}
	command["expectedDraftId"] = "22222222-2222-4222-8222-222222222222"
	if _, err = normalizeDiscoveryCommand(request, command, nil); err == nil {
		t.Fatal("unrequested draft binding accepted")
	}
}
