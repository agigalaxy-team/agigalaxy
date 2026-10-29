package actions

import (
	"strings"
	"testing"
)

func TestMessagePublicationReviewIncludesExactAudienceAndContent(t *testing.T) {
	id := "11111111-1111-4111-8111-111111111111"
	config := Object{"channels": []any{"inapp"}, "content": Object{"purpose": "service-update", "title": "Exact title", "body": "Exact body", "href": nil, "expiresAt": "2099-01-01T00:00:00Z"}, "audience": Object{"kind": "accounts", "accountIds": []any{id}}, "schedule": Object{"kind": "immediate"}, "senderKey": "notice", "automation": Object{"kind": "human-required", "factsConfirmed": false}}
	p := preparation{}
	if err := messagePublicationReview(&p, config); err != nil {
		t.Fatal(err)
	}
	lines := []string{}
	for _, value := range p.impact {
		lines = append(lines, str(value))
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{id, "Exact title", "Exact body", "immediate", "human-required", "inapp", "AGI Galaxy 通知"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("review omitted %q", want)
		}
	}
}
