package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
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
	fixture := readNativeContractFixture(t, "commands-v1.json")
	for i, input := range []CommandInput{{Command: "help"}, {Command: "language"}, {Command: "open", Language: "zh-CN", Stage: 3}, {Command: "setup", Language: "en-US", Stage: 5}} {
		original := uploadObject(uploadRows(fixture["previews"])[i])
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
	for i, name := range []string{"open", "case", "hub", "setup"} {
		original := uploadObject(uploadRows(fixture["initialized"])[i])
		got, e := r.Command(ctx, CommandInput{Command: name, Language: "en-US"})
		if e != nil {
			t.Fatal(e)
		}
		if name == "open" || name == "setup" {
			module := uploadObject(uploadRows(uploadObject(got)["enabledModules"])[0])
			if _, err := time.Parse(time.RFC3339Nano, text(module["enabledAt"])); err != nil {
				t.Fatal("invalid module timestamp", err)
			}
			uploadObject(uploadRows(original["enabledModules"])[0])["enabledAt"] = module["enabledAt"]
		}
		if name == "open" {
			status := uploadObject(uploadObject(uploadObject(got)["console"])["localStatus"])
			owner, err := store.Owner(ctx)
			if err != nil || status["galaxyId"] != owner {
				t.Fatal("command lost current owner", err)
			}
			uploadObject(uploadObject(original["console"])["localStatus"])["galaxyId"] = owner
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
	compareLegacyCommandSnapshot(t, "export", exported)
	assertInitializationIdentity(t, store.Directory, uploadObject(uploadObject(exported)["identity"]))

}

// Original JS projections, with per-run identity and timestamps checked and substituted.
func compareLegacyCommandSnapshot(t *testing.T, kind string, got any) {
	t.Helper()
	expected := readNativeContractFixture(t, "command-"+kind+"-legacy.json")
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]any
	if err = protocol.Decode(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	local := uploadObject(actual["identity"])
	original := uploadObject(expected["identity"])
	if !connectionGenesis(text(local["id"]), initializationMap(local["genesisProof"])) {
		t.Fatal("invalid identity genesis")
	}
	for _, key := range []string{"id", "createdAt", "publicKeyFingerprint"} {
		original[key] = local[key]
	}
	for _, key := range []string{"publicKeyPem", "nonce"} {
		uploadObject(original["genesisProof"])[key] = uploadObject(local["genesisProof"])[key]
	}
	var substitute func(any, any)
	substitute = func(want, have any) {
		switch w := want.(type) {
		case map[string]any:
			a, ok := have.(map[string]any)
			if !ok {
				return
			}
			for key, item := range w {
				if item == "__TIME__" {
					stamp, ok := a[key].(string)
					if !ok {
						t.Fatal("missing timestamp", key)
					}
					if _, e := time.Parse(time.RFC3339Nano, stamp); e != nil {
						t.Fatal(e)
					}
					w[key] = stamp
				} else if item == "__OWNER__" {
					if a[key] != local["id"] {
						t.Fatal("audit subject differs from identity")
					}
					w[key] = a[key]
				} else if item == "__EVENT__" {
					if text(a[key]) == "" {
						t.Fatal("missing audit event")
					}
					w[key] = a[key]
				} else {
					substitute(item, a[key])
				}
			}
		case []any:
			a, ok := have.([]any)
			if !ok || len(a) != len(w) {
				return
			}
			for i := range w {
				substitute(w[i], a[i])
			}
		}
	}
	substitute(expected["state"], actual["state"])
	if _, ok := expected["dataDir"]; ok {
		expected["dataDir"] = actual["dataDir"]
	}
	if _, ok := expected["exportedAt"]; ok {
		stamp := text(actual["exportedAt"])
		if _, e := time.Parse(time.RFC3339Nano, stamp); e != nil {
			t.Fatal(e)
		}
		expected["exportedAt"] = stamp
	}
	same(t, expected, actual)
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
	compareLegacyCommandSnapshot(t, "offline", snapshot)
	assertInitializationIdentity(t, directory, uploadObject(uploadObject(snapshot)["identity"]))
	currentScope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	repeated, e := store.InitializeLocalIdentity(ctx, "organization", true, &currentScope)
	if e != nil || !connectionEqual(snapshot, repeated) {
		t.Fatal("offline identity initialization was not idempotent", e)
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
	compareLegacyCommandSnapshot(t, "worker", worker)
	assertInitializationIdentity(t, filepath.Join(store.Directory, "workers", "first"), identity)
	repeated, e := store.InitializeWorkerIdentity(ctx, "first", true, &scope)
	if e != nil || !connectionEqual(worker, repeated) {
		t.Fatal("worker initialization was not idempotent", e)
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
