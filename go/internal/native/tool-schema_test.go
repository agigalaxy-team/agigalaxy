package native

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
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

func TestModelToolProjectionKeepsSchemaLocationsAndOriginalValidInputs(t *testing.T) {
	raw := []byte(`{"type":"object","default":{"const":9,"enum":[false,2],"properties":{"nested":{"const":17}}},"examples":[{"const":false,"enum":[1,2]}],"$defs":{"duration":{"type":"integer","enum":[7,30,90]}},"properties":{"flag":{"type":"boolean","const":true},"version":{"const":1},"duration":{"$ref":"#/$defs/duration"},"items":{"type":"array","items":{"type":"object","oneOf":[{"type":"object","properties":{"enabled":{"const":true}},"required":["enabled"]},{"type":"object","properties":{"enabled":{"const":false}},"required":["enabled"]}]}}},"required":["flag","version","duration","items"]}`)
	var original, published map[string]any
	if err := json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &published); err != nil {
		t.Fatal(err)
	}
	projectToolObjectFields(published)
	projectModelToolSchema(published)
	if !connectionEqual(original["default"], published["default"]) || !connectionEqual(original["examples"], published["examples"]) {
		t.Fatal("projection changed instance-valued annotations")
	}
	var inspect func(map[string]any)
	inspect = func(schema map[string]any) {
		t.Helper()
		if constant, exists := schema["const"]; exists {
			if _, ok := constant.(string); !ok {
				t.Fatalf("non-string const in published schema: %v", schema)
			}
		}
		if values, ok := schema["enum"].([]any); ok {
			for _, value := range values {
				if _, ok := value.(string); !ok {
					t.Fatalf("non-string enum in published schema: %v", schema)
				}
			}
		}
		forEachToolSubschema(schema, inspect)
	}
	inspect(published)
	properties := published["properties"].(map[string]any)
	flag := properties["flag"].(map[string]any)
	if flag["type"] != "boolean" || !strings.Contains(flag["description"].(string), "true") {
		t.Fatal("boolean constraint was not described", flag)
	}
	version := properties["version"].(map[string]any)
	if version["type"] != "integer" || version["minimum"] != float64(1) || version["maximum"] != float64(1) {
		t.Fatal("numeric constant changed type or bounds", version)
	}
	definition := published["$defs"].(map[string]any)["duration"].(map[string]any)
	if len(definition["anyOf"].([]any)) != 3 {
		t.Fatal("numeric alternatives missing", definition)
	}
	encoded, err := json.Marshal(published)
	if err != nil {
		t.Fatal(err)
	}
	var advertised jsonschema.Schema
	if err := json.Unmarshal(encoded, &advertised); err != nil {
		t.Fatal(err)
	}
	resolved, err := advertised.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, rawInput := range []string{
		`{"flag":true,"version":1,"duration":7,"items":[{"enabled":true}]}`,
		`{"flag":true,"version":1,"duration":90,"items":[{"enabled":false}]}`,
	} {
		var value any
		if err := json.Unmarshal([]byte(rawInput), &value); err != nil {
			t.Fatal(err)
		}
		if err := resolved.Validate(&value); err != nil {
			t.Fatalf("published schema rejected original valid input %s: %v", rawInput, err)
		}
	}
	var unsupportedDuration any
	if err := json.Unmarshal([]byte(`{"flag":true,"version":1,"duration":14,"items":[{"enabled":true}]}`), &unsupportedDuration); err != nil {
		t.Fatal(err)
	}
	if resolved.Validate(&unsupportedDuration) == nil {
		t.Fatal("numeric enum projection did not retain its exact alternatives")
	}
}

func TestModelProjectionMixedEnumAndExistingUnion(t *testing.T) {
	var schema map[string]any
	if err := json.Unmarshal([]byte(`{"type":"object","properties":{"mixed":{"enum":["automatic",7,false]},"flag":{"enum":[true]},"number":{"type":"integer","enum":[7,30,90],"anyOf":[{"minimum":1},{"maximum":100}]}}}`), &schema); err != nil {
		t.Fatal(err)
	}
	projectModelToolSchema(schema)
	properties := schema["properties"].(map[string]any)
	mixed := properties["mixed"].(map[string]any)
	if _, exists := mixed["enum"]; exists || !strings.Contains(mixed["description"].(string), `["automatic",7,false]`) {
		t.Fatal("mixed values not preserved in model description", mixed)
	}
	flag := properties["flag"].(map[string]any)
	if flag["type"] != "boolean" || !strings.Contains(flag["description"].(string), "true") {
		t.Fatal("boolean alternatives were not represented", flag)
	}
	number := properties["number"].(map[string]any)
	if len(number["anyOf"].([]any)) != 2 || number["minimum"] != float64(7) || number["maximum"] != float64(90) || !strings.Contains(number["description"].(string), "[7,30,90]") {
		t.Fatal("numeric union or its allowed values were lost", number)
	}
}

func TestRegisteredToolStillValidatesOriginalNonStringConstraints(t *testing.T) {
	ctx := context.Background()
	server := mcp.NewServer(&mcp.Implementation{Name: "schema-test", Version: "1"}, nil)
	var schema map[string]any
	if err := json.Unmarshal([]byte(`{"type":"object","properties":{"flag":{"type":"boolean","const":true},"version":{"type":"integer","const":1},"days":{"type":"integer","enum":[7,30,90]}},"required":["flag","version","days"],"additionalProperties":false}`), &schema); err != nil {
		t.Fatal(err)
	}
	calls := 0
	addNativeTool(server, &mcp.Tool{Name: "schema_fixture", InputSchema: schema}, "fixture_invalid", func(_ context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		calls++
		var value map[string]any
		if err := json.Unmarshal(request.Params.Arguments, &value); err != nil {
			return nil, err
		}
		return toolResult(value)
	})
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	clientSession, err := mcp.NewClient(&mcp.Implementation{Name: "schema-test", Version: "1"}, nil).Connect(ctx, clientTransport, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if err != nil {
		t.Fatal(err)
	}
	defer clientSession.Close()
	valid := materialCall(t, clientSession, "schema_fixture", map[string]any{"flag": true, "version": 1, "days": 30}, false)
	if valid["flag"] != true || valid["version"] != float64(1) || valid["days"] != float64(30) {
		t.Fatal("handler received changed JSON values", valid)
	}
	for _, input := range []map[string]any{
		{"flag": false, "version": 1, "days": 30},
		{"flag": true, "version": 2, "days": 30},
		{"flag": true, "version": 1, "days": 14},
	} {
		materialCall(t, clientSession, "schema_fixture", input, true)
	}
	if calls != 1 {
		t.Fatalf("invalid arguments reached handler: calls=%d", calls)
	}
}

func TestFullRuntimeAdvertisesNoNonStringConstantsOrEnums(t *testing.T) {
	ctx := context.Background()
	store, err := NewStore(t.TempDir(), "https://schema-fixture.invalid")
	if err != nil {
		t.Fatal(err)
	}
	runtime := commandRuntime(t, store)
	server, err := NewRuntimeToolServer(store, runtime)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer serverSession.Close()
	clientSession, err := mcp.NewClient(&mcp.Implementation{Name: "schema-catalog", Version: "1"}, nil).Connect(ctx, clientTransport, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if err != nil {
		t.Fatal(err)
	}
	defer clientSession.Close()
	count := 0
	for tool, err := range clientSession.Tools(ctx, nil) {
		if err != nil {
			t.Fatal(err)
		}
		count++
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatalf("%s: %v", tool.Name, err)
		}
		var schema map[string]any
		if err := json.Unmarshal(encoded, &schema); err != nil {
			t.Fatalf("%s: %v", tool.Name, err)
		}
		var inspect func(map[string]any)
		inspect = func(node map[string]any) {
			t.Helper()
			if value, exists := node["const"]; exists {
				if _, ok := value.(string); !ok {
					t.Fatalf("%s advertises a non-string const: %v", tool.Name, value)
				}
			}
			if values, ok := node["enum"].([]any); ok {
				for _, value := range values {
					if _, ok := value.(string); !ok {
						t.Fatalf("%s advertises a non-string enum: %v", tool.Name, value)
					}
				}
			}
			forEachToolSubschema(node, inspect)
		}
		inspect(schema)
	}
	if count == 0 {
		t.Fatal("no tools discovered")
	}
}
