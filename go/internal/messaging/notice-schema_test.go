package messaging

import (
	"strings"
	"testing"
)

// Both original Zod schemas count code points; the standalone notice surface
// deliberately retains whitespace while the messaging-plan surface trims it.
func TestOriginalNoticeAndPlanTextBoundaries(t *testing.T) {
	for _, limit := range []struct {
		field string
		max   int
	}{{"title", 160}, {"body", 8000}} {
		for _, over := range []bool{false, true} {
			length := limit.max
			if over {
				length++
			}
			content := Object{"purpose": "maintenance", "title": "title", "body": "body", "expiresAt": "2099-01-01T00:00:00Z", "audience": Object{"kind": "all-accounts"}}
			content[limit.field] = strings.Repeat("\U0001f600", length)
			_, err := noticeContent(content)
			if (err != nil) != over {
				t.Fatalf("notice %s length %d: %v", limit.field, length, err)
			}
			delete(content, "audience")
			_, err = normalizeConfig(Object{"channels": []any{"announcement"}, "content": content, "audience": Object{"kind": "all-accounts"}, "schedule": Object{"kind": "immediate"}})
			if (err != nil) != over {
				t.Fatalf("plan %s length %d: %v", limit.field, length, err)
			}
		}
	}
	content := Object{"purpose": "maintenance", "title": " title ", "body": " body ", "expiresAt": "2099-01-01T00:00:00Z", "audience": Object{"kind": "all-accounts"}}
	notice, err := noticeContent(content)
	if err != nil || notice["title"] != " title " || notice["body"] != " body " {
		t.Fatalf("notice whitespace: %v %v", notice, err)
	}
	delete(content, "audience")
	plan, err := normalizeConfig(Object{"channels": []any{"inapp"}, "content": content, "audience": Object{"kind": "all-accounts"}, "schedule": Object{"kind": "immediate"}})
	if err != nil || obj(plan["content"])["title"] != "title" || obj(plan["content"])["body"] != "body" {
		t.Fatalf("plan whitespace: %v %v", plan, err)
	}
}
