package native

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPInitializationRequiresActualChoiceBeforeIdentity(t *testing.T) {
	ctx := context.Background()
	directory := filepath.Join(t.TempDir(), "not-yet-created")
	store, e := NewStore(directory, "https://galaxy.invalid")
	if e != nil {
		t.Fatal(e)
	}
	no := connectMCP(t, store, "2025-11-25", false)
	input := map[string]any{"initializationPath": "personal-galaxy", "subjectType": "organization"}
	for _, name := range []string{"galaxy_native_initialize_preview", "galaxy_native_initialize"} {
		result, e := no.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: input})
		if e != nil || result.IsError {
			t.Fatalf("%s: %v %#v", name, e, result)
		}
		if _, e = os.Stat(directory); !os.IsNotExist(e) {
			t.Fatal("preview/decline created local identity files")
		}
	}
	yes := connectMCP(t, store, "2025-11-25", true)
	result, e := yes.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_native_initialize", Arguments: input})
	if e != nil || result.IsError {
		t.Fatalf("confirmed initialization: %v %#v", e, result)
	}
	before, e := os.ReadFile(filepath.Join(directory, "galaxy-id.json"))
	if e != nil {
		t.Fatal(e)
	}
	result, e = yes.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_native_initialize", Arguments: input})
	if e != nil || result.IsError {
		t.Fatalf("existing identity: %v %s", e, mustJSON(result))
	}
	after, e := os.ReadFile(filepath.Join(directory, "galaxy-id.json"))
	if e != nil || string(before) != string(after) {
		t.Fatal("existing identity changed")
	}
	result, e = yes.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_native_initialize", Arguments: map[string]any{"uploadPrivacy": map[string]any{}}})
	if e != nil || !result.IsError {
		t.Fatal("missing explicit privacy level accepted")
	}
}

func TestNetworkInitializationProjection(t *testing.T) {
	preview, err := PreviewInitialization(InitializationInput{SubjectType: "person"})
	if err != nil {
		t.Fatal(err)
	}
	networkInitializationProjection(preview, "preview")
	if preview["remoteEffects"] != "none" || preview["onConfirmation"] != "initialize-local-and-connect-service" || preview["localOnly"] != false {
		t.Fatalf("incorrect preview: %v", preview)
	}
	result := map[string]any{"initialized": true, "localOnly": true, "result": map[string]any{"localOnly": true, "plan": map[string]any{"remoteEffects": "none", "notes": []string{"local only"}}}}
	networkInitializationProjection(result, "ready")
	plan := uploadObject(uploadObject(result["result"])["plan"])
	if result["localOnly"] != false || result["remoteEffects"] != "service-connected" || plan["remoteEffects"] != nil || plan["notes"] != nil {
		t.Fatalf("incorrect completed result: %v", result)
	}
}
