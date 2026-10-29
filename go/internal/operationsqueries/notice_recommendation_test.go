package operationsqueries

import "testing"

func TestNoticeAndRecommendationExactReadsAreClosed(t *testing.T) {
	id := "7f8fb2cc-c1ad-40a7-9078-d0054bf1a916"
	for _, kind := range []string{"notice", "recommendation-theme"} {
		if _, e := parse("read-operation-object", Object{"kind": kind, "id": id, "filters": Object{}}); e != nil {
			t.Fatalf("%s: %v", kind, e)
		}
	}
	for _, route := range []Object{{"module": "messaging", "view": "notices", "filters": Object{"limit": 20}}, {"module": "recommendations", "view": "policy", "filters": Object{}}} {
		if _, e := parse("query-operations", route); e != nil {
			t.Fatalf("%v: %v", route, e)
		}
	}
}
