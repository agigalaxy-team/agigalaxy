package webevents

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFixedCatalogAndMinimalFrames(t *testing.T) {
	for _, e := range []Event{{SourceTable: "operations_model_settings_state_v1; SELECT 1", Module: "model-settings"}, {SourceTable: "unregistered", Module: ""}, {SourceTable: "forum_posts_v1", Module: "model-settings"}} {
		if validSource(e) {
			t.Fatalf("untrusted producer accepted: %+v", e)
		}
	}
	if !validSource(Event{SourceTable: "forum_posts_v1", Module: "information"}) {
		t.Fatal("original source alias lost")
	}
	for _, f := range []Frame{{Type: "reset", Cursor: "0"}, {Type: "snapshot", Cursor: "0"}, {Type: "change", Cursor: "1", Module: "feedback"}} {
		b, e := json.Marshal(f)
		if e != nil {
			t.Fatal(e)
		}
		if f.Type == "change" && !strings.Contains(string(b), `"operationId":null`) {
			t.Fatalf("null receipt changed: %s", b)
		}
		if f.Type != "change" && !strings.Contains(string(b), `"modules":[]`) {
			t.Fatalf("empty reset lost: %s", b)
		}
	}
}
