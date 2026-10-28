package native

import (
	"context"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func commandRuntime(t *testing.T, store *Store) *Runtime {
	t.Helper()
	r, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(r.Close)
	return r
}
func TestCommandOriginalLocalPresentationAndReadBoundaries(t *testing.T) {
	ctx := context.Background()
	store, e := NewStore(t.TempDir(), "https://command.invalid")
	if e != nil {
		t.Fatal(e)
	}
	r := commandRuntime(t, store)
	for _, input := range []CommandInput{{Command: "help"}, {Command: "language"}, {Command: "open", Language: "zh-CN", Stage: 3}, {Command: "setup", Language: "en-US", Stage: 5}} {
		original := initializationNode(t, `import {getGalaxyCommandSurface} from './packages/galaxy-core/src/local-store.mjs';console.log(JSON.stringify(await getGalaxyCommandSurface(process.argv[1],process.argv[2],{language:process.argv[3]||undefined,stage:Number(process.argv[4])||undefined})));`, store.Directory, input.Command, input.Language, fmtInt(input.Stage))
		got, e := r.Command(ctx, input)
		if e != nil {
			t.Fatal(e)
		}
		if !connectionEqual(got, commandNativeReferences(original)) {
			t.Fatalf("original command differs (%v): got=%v original=%v", input, got, original)
		}
	}
	if owner, e := store.Owner(ctx); e != nil || owner != "" {
		t.Fatal("command created identity", e)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	bare, e := store.InitializeLocalIdentity(ctx, "", true, &scope)
	if e != nil {
		t.Fatal(e)
	}
	if uploadObject(uploadObject(bare)["identity"])["subjectType"] != "person" {
		t.Fatal("default subject differs")
	}
	result, e := r.Command(ctx, CommandInput{Command: "status"})
	if e != nil || uploadObject(result)["state"] != "not-initialized" {
		t.Fatal(result, e)
	}
	scope, e = store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.Initialize(ctx, InitializationInput{Profile: "minimal"}, true, &scope); e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"open", "case", "hub", "setup"} {
		original := initializationNode(t, `import {getGalaxyCommandSurface} from './packages/galaxy-core/src/local-store.mjs';console.log(JSON.stringify(await getGalaxyCommandSurface(process.argv[1],process.argv[2],{language:'en-US'})));`, store.Directory, name)
		got, e := r.Command(ctx, CommandInput{Command: name, Language: "en-US"})
		if e != nil {
			t.Fatal(e)
		}
		if !connectionEqual(got, commandNativeReferences(original)) {
			t.Fatalf("initialized command differs %s: got=%v original=%v", name, got, original)
		}
	}
	website, e := r.Command(ctx, CommandInput{Command: "website"})
	if e != nil || uploadObject(website)["opened"] != false || uploadObject(website)["website"] != "https://website.invalid" {
		t.Fatal(website, e)
	}
	exported, e := store.ExportLocalData(ctx)
	if e != nil {
		t.Fatal(e)
	}
	originalExport := initializationNode(t, `import {exportLocalData} from './packages/galaxy-core/src/local-store.mjs';console.log(JSON.stringify(await exportLocalData(process.argv[1])));`, store.Directory)
	delete(originalExport, "exportedAt")
	delete(uploadObject(exported), "exportedAt")
	if !connectionEqual(exported, originalExport) {
		t.Fatalf("export differs %v / %v", exported, originalExport)
	}
}
func fmtInt(n int) string {
	if n == 0 {
		return "0"
	}
	return string(rune('0' + n))
}

func TestCommandOfflineFallbackWithoutAuthority(t *testing.T) {
	ctx := context.Background()
	directory := filepath.Join(t.TempDir(), "offline")
	store, e := NewStore(directory, "")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.LocalStatus(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = store.ExportLocalData(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(directory); !os.IsNotExist(e) {
		t.Fatal("offline reads created directory")
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	snapshot, e := store.InitializeLocalIdentity(ctx, "organization", true, &scope)
	if e != nil {
		t.Fatal(e)
	}
	original := initializationNode(t, `import {initializeLocalGalaxyId} from './packages/galaxy-core/src/local-store.mjs';console.log(JSON.stringify(await initializeLocalGalaxyId(process.argv[1],{subjectType:'organization'})));`, directory)
	if !connectionEqual(snapshot, original) {
		t.Fatal("offline original differs")
	}
	if _, e = os.Stat(filepath.Join(directory, "native-v2")); !os.IsNotExist(e) {
		t.Fatal("offline fallback created Native service records")
	}
}

func TestCommandWorkerOriginalInteropAndParentScope(t *testing.T) {
	ctx := context.Background()
	store, e := NewStore(t.TempDir(), "https://worker.invalid")
	if e != nil {
		t.Fatal(e)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	worker, e := store.InitializeWorkerIdentity(ctx, "first", true, &scope)
	if e != nil {
		t.Fatal(e)
	}
	identity := uploadObject(uploadObject(worker)["identity"])
	if identity["subjectType"] != "agent" || identity["clientKind"] != "worker" {
		t.Fatal(worker)
	}
	original := initializationNode(t, `import {initializeLocalWorkerGalaxyId} from './packages/galaxy-core/src/local-store.mjs';console.log(JSON.stringify(await initializeLocalWorkerGalaxyId(process.argv[1],{workerId:'first'})));`, store.Directory)
	if !connectionEqual(worker, original) {
		t.Fatal("original JS did not retain same Worker", worker, original)
	}
	if owner, e := store.Owner(ctx); e != nil || owner != "" {
		t.Fatal("Worker altered parent identity", e)
	}
	if _, e = store.InitializeLocalIdentity(ctx, "person", true, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = store.InitializeWorkerIdentity(ctx, "stale", true, &scope); e == nil {
		t.Fatal("old parent scope accepted")
	}
	if _, e = os.Stat(filepath.Join(store.Directory, "workers", "stale")); !os.IsNotExist(e) {
		t.Fatal("stale review created child")
	}
	before := map[string][]byte{}
	for _, name := range []string{"galaxy-id.json", "galaxy-id-private-key.pem", "galaxy-id-public-key.pem", "galaxy-local-state.json"} {
		before[name], e = os.ReadFile(filepath.Join(store.Directory, name))
		if e != nil {
			t.Fatal(e)
		}
	}
	scope, e = store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.InitializeWorkerIdentity(ctx, "second", true, &scope); e != nil {
		t.Fatal(e)
	}
	for name, raw := range before {
		after, e := os.ReadFile(filepath.Join(store.Directory, name))
		if e != nil || !reflect.DeepEqual(raw, after) {
			t.Fatal("parent material changed", name, e)
		}
	}
	for _, id := range []string{"../escape", "/absolute", "", "bad.name"} {
		if _, e = store.InitializeWorkerIdentity(ctx, id, true, &scope); e == nil {
			t.Fatal("invalid Worker accepted", id)
		}
	}
	if e = os.MkdirAll(filepath.Join(store.Directory, "workers", "remnant"), 0700); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(store.Directory, "workers", "remnant", "galaxy-id-private-key.pem")
	if e = os.WriteFile(path, []byte("synthetic-remnant"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = store.InitializeWorkerIdentity(ctx, "remnant", true, &scope); e == nil {
		t.Fatal("replaced orphan key")
	}
	if raw, _ := os.ReadFile(path); string(raw) != "synthetic-remnant" {
		t.Fatal("orphan key modified")
	}
}
func TestCommandToolStrictSchemasAndBlankWorkerReview(t *testing.T) {
	ctx := context.Background()
	store, e := NewStore(t.TempDir(), "https://worker.invalid")
	if e != nil {
		t.Fatal(e)
	}
	r := commandRuntime(t, store)
	server := mcp.NewServer(&mcp.Implementation{Name: "commands", Version: "1"}, nil)
	registerCommandTools(server, &toolRuntime{store: store, key: make([]byte, 32), choices: map[string]*choiceRecord{}}, r)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer ss.Close()
	count := 0
	client := mcp.NewClient(&mcp.Implementation{Name: "commands", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		count++
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": true}}, nil
	}})
	cs, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	if e != nil {
		t.Fatal(e)
	}
	defer cs.Close()
	materialCall(t, cs, "galaxy_command", map[string]any{"stage": 0}, true)
	materialCall(t, cs, "galaxy_command", map[string]any{"command": nil}, true)
	materialCall(t, cs, "galaxy_local_worker_identity_create", map[string]any{"workerId": "a", "confirmed": true}, true)
	materialCall(t, cs, "galaxy_local_worker_identity_create", map[string]any{}, true)
	result := materialCall(t, cs, "galaxy_local_worker_identity_create", map[string]any{"workerId": "reviewed"}, false)
	if result["workerId"] != "reviewed" || count != 1 {
		t.Fatal("blank Worker review missing", result, count)
	}
}
