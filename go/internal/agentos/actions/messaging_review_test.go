package actions

import (
	"fmt"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/messaging"
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

func TestMessageDraftReviewIncludesNormalizedConfig(t *testing.T) {
	id := "0fbc678d-4d33-4e81-84c6-5a5a83c868e9"
	for _, audience := range []Object{
		{"kind": "accounts", "accountIds": []any{id}},
		{"kind": "attributes", "subjectTypes": []any{"person", "agent"}},
	} {
		config := Object{"channels": []any{"inapp"}, "content": Object{"purpose": "maintenance", "title": "Review title", "body": "Review body", "href": "/notice", "expiresAt": "2099-01-01T00:00:00Z"}, "audience": audience, "schedule": Object{"kind": "immediate"}, "senderKey": "notice"}
		normalized, err := messaging.ParseDraftConfiguration(config)
		if err != nil {
			t.Fatal(err)
		}
		for _, operation := range []string{"create", "save"} {
			t.Run(operation+str(audience["kind"]), func(t *testing.T) {
				p := preparation{}
				if err := messageDraftReview(&p, normalized); err != nil {
					t.Fatal(err)
				}
				lines := []string{}
				for _, value := range p.impact {
					lines = append(lines, str(value))
				}
				review := strings.Join(lines, "\n")
				expected := []string{"仅保存草稿", "不发布、不发送", "maintenance", "Review title", "Review body", "/notice", "2099-01-01", "inapp", "immediate", "human-required", "AGI Galaxy 通知"}
				if str(audience["kind"]) == "accounts" {
					expected = append(expected, id)
				} else {
					expected = append(expected, "person", "agent")
				}
				for _, value := range expected {
					if !strings.Contains(review, value) {
						t.Errorf("review omitted %q", value)
					}
				}
				if got := messagePurpose(normalized); got != "维护通知（maintenance）" {
					t.Errorf("purpose = %q", got)
				}
			})
		}
	}
}

func TestMessageDraftReviewRejectsOversizedCompleteAudience(t *testing.T) {
	ids := make([]any, 500)
	for i := range ids {
		ids[i] = fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1)
	}
	config := Object{"channels": []any{"inapp"}, "content": Object{"purpose": "community-update", "title": "title", "body": strings.Repeat("x", 2000), "href": nil, "expiresAt": "2099-01-01T00:00:00Z"}, "audience": Object{"kind": "accounts", "accountIds": ids}, "schedule": Object{"kind": "immediate"}, "senderKey": "notice"}
	normalized, err := messaging.ParseDraftConfiguration(config)
	if err != nil {
		t.Fatal(err)
	}
	err = messageDraftReview(&preparation{}, normalized)
	if fault.Code(err) != "operations_agentos_message_review_required" {
		t.Fatalf("expected complete review rejection, got %v", err)
	}
}
