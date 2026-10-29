package native

import (
	"context"
	"crypto/rand"
	"fmt"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func interactionRuntime(t *testing.T, s *Store) *Runtime {
	t.Helper()
	r, e := NewRuntime(s, Configuration{Version: 2, Endpoint: s.Endpoint, Website: "https://selected.invalid", DataDirectory: s.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{HTTPClient: &http.Client{Transport: runtimeNoNetwork{t}}})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { r.Close() })
	return r
}
func interactionArtifact(t *testing.T) *InteractionArtifact {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	artifact, e := LoadInteractionArtifact(filepath.Clean(filepath.Join(filepath.Dir(file), "../../../integrations/native-v2/compact-app/dist")))
	if e != nil {
		t.Fatal(e)
	}
	return artifact
}
func interactionReviewer(t *testing.T, s *Store) InteractionAppReviewer {
	t.Helper()
	key := make([]byte, 32)
	if _, e := rand.Read(key); e != nil {
		t.Fatal(e)
	}
	tools := &toolRuntime{store: s, key: key, choices: map[string]*choiceRecord{}, browser: NewBrowserChoices(s, nil)}
	t.Cleanup(func() { tools.browser.Close() })
	return func(ctx context.Context, req *mcp.CallToolRequest, name string, input any, message string, run func(*ChoiceScope) (any, error)) (*mcp.CallToolResult, error) {
		copy := *req
		params := *req.Params
		params.Name = name
		copy.Params = &params
		return tools.review(ctx, &copy, input, message, run)
	}
}
func TestInteractionAppsOriginalSnapshotAndPrivateResultProjection(t *testing.T) {
	store, expected := fixture(t)
	rt := interactionRuntime(t, store)
	work := initializationMap(expected["get"])
	workID := text(initializationMap(work["work"])["workId"])
	archiveList, e := store.ArchiveList(context.Background(), ArchiveQuery{Limit: 1})
	if e != nil {
		t.Fatal(e)
	}
	archivePage, _ := interactionMap(archiveList)
	archiveID := text(initializationMap(initializationArray(archivePage["items"])[0])["archiveSessionId"])
	for index, input := range []interactionPanelInput{{View: "history"}, {View: "history", WorkID: workID}, {View: "archive"}, {View: "archive", ArchiveSessionID: archiveID}, {View: "privacy"}} {
		raw, _ := protocol.Encode(input)
		t.Run(string(raw), func(t *testing.T) {
			got, e := rt.interactionPanelSnapshot(context.Background(), input)
			if e != nil {
				t.Fatal(e)
			}
			want := readNativeContractFixture(t, fmt.Sprintf("interaction-%d.json", index))
			same(t, want, got)
			result := interactionComponent(got)
			model, _ := protocol.Encode(struct {
				Content           []mcp.Content `json:"content"`
				StructuredContent any           `json:"structuredContent"`
			}{result.Content, result.StructuredContent})
			if strings.Contains(string(model), "继续检查未整理") || strings.Contains(string(model), "selectedWork") || strings.Contains(string(model), "observations") || strings.Contains(string(model), workID) {
				t.Fatal("private record leaked into model-visible content")
			}
			if result.Meta["galaxyLocalWork"] == nil {
				t.Fatal("component lost private payload")
			}
		})
	}
}
func TestInteractionAppsActualMCPResourceMetadataAndScopedPanel(t *testing.T) {
	ctx := context.Background()
	store, expected := fixture(t)
	rt := interactionRuntime(t, store)
	artifact := interactionArtifact(t)
	server := mcp.NewServer(&mcp.Implementation{Name: "galaxy-app-local-test", Version: "1"}, nil)
	if e := RegisterInteractionApps(server, rt, artifact, interactionReviewer(t, store), InteractionAppOperations{}); e != nil {
		t.Fatal(e)
	}
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, serverTransport, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	client := mcp.NewClient(&mcp.Implementation{Name: "synthetic-no-ui-client", Version: "1"}, nil)
	cs, e := client.Connect(ctx, clientTransport, &mcp.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	resources, e := cs.ListResources(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(resources.Resources) != 1 || resources.Resources[0].URI != artifact.URI || resources.Resources[0].MIMEType != InteractionAppMIME {
		t.Fatal(resources)
	}
	resource, e := cs.ReadResource(ctx, &mcp.ReadResourceParams{URI: artifact.URI})
	if e != nil {
		t.Fatal(e)
	}
	if resource.Contents[0].Text != artifact.HTML {
		t.Fatal("existing shipped HTML was changed")
	}
	same(t, interactionResourceMeta(), resource.Contents[0].Meta)
	tools, e := cs.ListTools(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	var public, private *mcp.Tool
	for _, tool := range tools.Tools {
		if tool.Name == "galaxy_local_panel" {
			public = tool
		}
		if tool.Name == "galaxy_local_panel_read" {
			private = tool
		}
	}
	if public == nil || private == nil {
		t.Fatal("existing local panel tools missing")
	}
	same(t, InteractionToolMeta(artifact.URI, false), public.Meta)
	same(t, InteractionToolMeta(artifact.URI, true), private.Meta)
	work := initializationMap(expected["get"])
	id := text(initializationMap(work["work"])["workId"])
	result, e := cs.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_local_panel_read", Arguments: map[string]any{"view": "history", "workId": id}})
	if e != nil || result.IsError {
		t.Fatal(e, result)
	}
	privateData := initializationMap(result.Meta["galaxyLocalWork"])
	same(t, work, privateData["selectedWork"])
	stale, e := cs.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_local_panel_read", Arguments: map[string]any{"view": "history", "galaxyId": "different-owner", "workId": id}})
	if e != nil || !stale.IsError {
		t.Fatal(e, stale)
	}
	if initializationMap(stale.StructuredContent)["error"] != "local_identity_changed" {
		t.Fatal(stale)
	}
	invalid, e := cs.CallTool(ctx, &mcp.CallToolParams{Name: "galaxy_local_panel_read", Arguments: map[string]any{"view": "history", "confirmed": true}})
	if e != nil || !invalid.IsError {
		t.Fatal("unknown argument was accepted", e, invalid)
	}
	copy := *artifact
	copy.HTML += "changed"
	if e = RegisterInteractionResource(mcp.NewServer(&mcp.Implementation{Name: "synthetic", Version: "1"}, nil), &copy); e == nil {
		t.Fatal("changed HTML was advertised")
	}
}
