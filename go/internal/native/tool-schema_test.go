package native

import (
	"encoding/json"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
)

func TestToolUnionProjectionExposesFieldsWithoutChangingValidInputs(t *testing.T) {
	raw := []byte(`{"type":"object","oneOf":[{"type":"object","properties":{"action":{"const":"providers"}},"required":["action"],"additionalProperties":false},{"type":"object","properties":{"action":{"const":"begin"},"providerId":{"type":"string"}},"required":["action","providerId"],"additionalProperties":false},{"type":"object","properties":{"action":{"enum":["status","cancel"],"type":"string"},"id":{"type":"string"}},"required":["action","id"],"additionalProperties":false},{"type":"object","properties":{"action":{"const":"query"},"limit":{"type":"integer","minimum":1}},"required":["action"],"additionalProperties":false}]}`)
	var published map[string]any
	if e := json.Unmarshal(raw, &published); e != nil {
		t.Fatal(e)
	}
	projectToolObjectFields(published)
	properties := published["properties"].(map[string]any)
	action := properties["action"].(map[string]any)
	if action["type"] != "string" || len(action["enum"].([]any)) != 5 || len(properties) != 4 || !connectionEqual(published["required"], []string{"action"}) {
		t.Fatal("SDK-visible fields or discriminator missing", published)
	}
	resolve := func(b []byte) *jsonschema.Resolved {
		t.Helper()
		var schema jsonschema.Schema
		if e := json.Unmarshal(b, &schema); e != nil {
			t.Fatal(e)
		}
		r, e := schema.Resolve(nil)
		if e != nil {
			t.Fatal(e)
		}
		return r
	}
	original := resolve(raw)
	encoded, e := json.Marshal(published)
	if e != nil {
		t.Fatal(e)
	}
	projected := resolve(encoded)
	for _, input := range []string{`{}`, `{"action":"query"}`, `{"action":"providers","limit":3}`, `{"action":"begin"}`, `{"action":"begin","providerId":"galaxy-account"}`, `{"action":"status","id":"original"}`, `{"action":"unknown"}`, `{"action":"query","limit":0}`} {
		var value any
		if e := json.Unmarshal([]byte(input), &value); e != nil {
			t.Fatal(e)
		}
		if (original.Validate(&value) == nil) != (projected.Validate(&value) == nil) {
			t.Fatal("projection changed accepted inputs", input)
		}
	}
}
