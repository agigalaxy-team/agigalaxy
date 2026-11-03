package personalmcp

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestPersonalToolAdvertisementKeepsOriginalValidation(t *testing.T) {
	raw := json.RawMessage(`{"type":"object","properties":{"flag":{"type":"boolean","const":true},"version":{"type":"integer","const":1},"days":{"type":"integer","enum":[7,30,90]}},"required":["flag","version","days"],"additionalProperties":false}`)
	var original jsonschema.Schema
	if err := json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	resolved, err := original.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	d := definition{Name: "fixture", InputSchema: raw, resolved: resolved}
	h := &Handler{tools: []definition{d}}
	server := h.server(deviceauth.OAuthAuthentication{}, nil)
	ct, st := mcp.NewInMemoryTransports()
	ss, err := server.Connect(context.Background(), st, nil)
	if err != nil {
		t.Fatal(err)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "schema-fixture", Version: "1"}, nil)
	cs, err := client.Connect(context.Background(), ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close(); ss.Close() })
	listed, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed.Tools) != 1 {
		t.Fatal("unexpected tool catalog", len(listed.Tools))
	}
	encoded, err := json.Marshal(listed.Tools[0].InputSchema)
	if err != nil {
		t.Fatal(err)
	}
	var visible map[string]any
	if err = json.Unmarshal(encoded, &visible); err != nil {
		t.Fatal(err)
	}
	properties := visible["properties"].(map[string]any)
	flag := properties["flag"].(map[string]any)
	version := properties["version"].(map[string]any)
	days := properties["days"].(map[string]any)
	if _, ok := flag["const"]; ok {
		t.Fatal("boolean const was advertised unchanged")
	}
	if _, ok := version["const"]; ok {
		t.Fatal("numeric const was advertised unchanged")
	}
	if _, ok := days["enum"]; ok {
		t.Fatal("numeric enum was advertised unchanged")
	}
	var projected jsonschema.Schema
	if err = json.Unmarshal(encoded, &projected); err != nil {
		t.Fatal(err)
	}
	advertised, err := projected.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	valid := map[string]any{"flag": true, "version": float64(1), "days": float64(7)}
	if err = advertised.Validate(&valid); err != nil {
		t.Fatal("advertisement rejects original valid input", err)
	}
	for _, value := range []json.RawMessage{json.RawMessage(`{"flag":false,"version":1,"days":7}`), json.RawMessage(`{"flag":true,"version":2,"days":7}`), json.RawMessage(`{"flag":true,"version":1,"days":14}`)} {
		if _, err = parseArguments(d, value); err == nil {
			t.Fatalf("original validator accepted %s", value)
		}
	}
}
