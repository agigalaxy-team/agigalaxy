package actions

import (
	"strings"
	"testing"
)

func TestStrategyReviewShowsCompleteChangedExecutionAndChunks(t *testing.T) {
	before := Object{"common": Object{"objective": "old"}, "domains": []any{}, "strategies": []any{Object{"id": "one", "execution": Object{"actions": []any{"content.hide"}, "resourceScope": Object{"kind": "eligible"}}}}}
	after := Object{"common": Object{"objective": "new"}, "domains": []any{}, "strategies": []any{Object{"id": "one", "execution": Object{"actions": []any{"content.restore"}, "resourceScope": Object{"kind": "selected", "resourceIds": []any{"selected"}}}}}}
	lines, err := strategyDifference(before, after)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"old", "new", "content.hide", "content.restore", "eligible", "selected"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("review omitted %q: %s", want, joined)
		}
	}
	value := strings.Repeat("a😀", 3000)
	parts := strategyReviewChunks(value, 4000)
	if strings.Join(parts, "") != value {
		t.Fatal("review chunks changed content")
	}
	for _, part := range parts {
		if jsLength(part) > 4000 {
			t.Fatal("review chunk exceeded UTF-16 limit")
		}
	}
}
