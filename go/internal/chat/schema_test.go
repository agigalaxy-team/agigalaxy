package chat

import (
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"testing"
)

func TestOriginalAstralSchemaCodePointLimits(t *testing.T) {
	f := chatNode(t, "postgres://127.0.0.1/galaxy_go_test_chat_schema", "schema-astral", nil)
	for _, value := range f["cases"].([]any) {
		v := value.(map[string]any)
		var got Object
		var e error
		input := obj(v, "input")
		raw := encode(input)
		switch str(v, "kind") {
		case "create":
			got, e = parseCreate(raw)
		case "send":
			got, e = parseSend(raw)
		case "edit":
			got, e = parseEdit(raw)
		case "summary":
			var ok bool
			got, ok = summaryContent(input)
			if !ok {
				e = sharedError()
			}
		case "contact":
			got, e = parseContactEvent(raw)
		case "project":
			got, e = projects.ParseEvent(raw)
		default:
			t.Fatal("unknown schema")
		}
		if (e == nil) != truth(v, "accepted") {
			t.Fatalf("%s original astral decision differs: %v", str(v, "kind"), e)
		}
		if e == nil {
			same(t, got, v["normalized"])
		}
	}
}
