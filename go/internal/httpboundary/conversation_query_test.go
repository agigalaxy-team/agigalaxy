package httpboundary

import "testing"

func TestConversationPageQueries(t *testing.T) {
	root := "/v1/operations/agentos/conversations/overview/"
	for _, v := range []struct {
		path, query string
		want        bool
	}{
		{"history", "before=YWJj_123", true}, {"history", "before=", false}, {"history", "before=a&before=b", false},
		{"cards", "turnId=56341725-5cfe-4653-8e15-a139a82f4c13", true},
		{"cards", "turnId=56341725-5cfe-4653-8e15-a139a82f4c13&turnId=79523894-fc40-40f4-95cf-df418b0ef177", true},
		{"cards", "turnId=bad", false}, {"cards", "turnId=56341725-5cfe-4653-8e15-a139a82f4c13&other=x", false},
	} {
		if got := AllowedQuery("GET", root+v.path, v.query, ""); got != v.want {
			t.Errorf("%s: got %v", v.query, got)
		}
	}
}
