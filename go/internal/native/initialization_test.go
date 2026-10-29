package native

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

func initializationNode(t *testing.T, script string, args ...string) map[string]any {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "../../.."))
	command := exec.Command("node", append([]string{"--input-type=module", "-e", script}, args...)...)
	command.Dir = root
	output, e := command.Output()
	if e != nil {
		t.Fatalf("Node interop: %v: %s", e, output)
	}
	var result map[string]any
	if e = protocol.Decode(output, &result); e != nil {
		t.Fatalf("Node JSON: %v: %s", e, output)
	}
	return result
}

// Fixed synthetic contract observations from the original implementation.
func nativeContractFixture(t *testing.T) map[string]any {
	return readNativeContractFixture(t, t.Name()+".json")
}
func readNativeContractFixture(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "contracts", name))
	if err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err = protocol.Decode(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

// The original Node journal bytes, with only per-run identity, event and key values substituted.
// No private key is stored in the fixture; initializationNew generates it for this test process.
func legacyInitializationFixture(t *testing.T) (initializationRecord, []byte) {
	t.Helper()
	record, err := initializationNew("person")
	if err != nil {
		t.Fatal(err)
	}
	var local, state map[string]any
	if err = json.Unmarshal(record.Identity, &local); err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(record.State, &state); err != nil {
		t.Fatal(err)
	}
	proof := local["genesisProof"].(map[string]any)
	event := state["auditEvents"].([]any)[0].(map[string]any)
	raw, err := os.ReadFile(filepath.Join("testdata", "contracts", "legacy-initialization-journal-template.json"))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{"__ID__": local["id"].(string), "__PUBLIC__": record.PublicKeyPEM, "__PRIVATE__": record.PrivateKeyPEM, "__NONCE__": proof["nonce"].(string), "__FINGERPRINT__": local["publicKeyFingerprint"].(string), "__CREATED__": local["createdAt"].(string), "__EVENT__": event["id"].(string)} {
		placeholder, _ := json.Marshal(name)
		encoded, _ := json.Marshal(value)
		if !bytes.Contains(raw, placeholder) {
			t.Fatalf("fixture missing %s", name)
		}
		raw = bytes.ReplaceAll(raw, placeholder, encoded)
	}
	var original initializationRecord
	if err = json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	if err = initializationValidate(original); err != nil {
		t.Fatal(err)
	}
	return original, raw
}
func assertInitializationIdentity(t *testing.T, dir string, expected map[string]any) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "galaxy-id.json"))
	if err != nil {
		t.Fatal(err)
	}
	var local map[string]any
	if err = protocol.Decode(data, &local); err != nil {
		t.Fatal(err)
	}
	same(t, expected, local)
	if !connectionGenesis(text(local["id"]), initializationMap(local["genesisProof"])) {
		t.Fatal("invalid genesis")
	}
	priv, err := os.ReadFile(filepath.Join(dir, "galaxy-id-private-key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	key, err := identity.PrivatePEM(priv)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := identity.PublicPEM(key.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	saved, err := os.ReadFile(filepath.Join(dir, "galaxy-id-public-key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	if pub != string(saved) || pub != initializationMap(local["genesisProof"])["publicKeyPem"] {
		t.Fatal("identity key mismatch")
	}
	// Shared Genesis contract and the standard Node crypto implementation independently
	// verify the generated local bytes; no retired Core implementation is loaded.
	check := initializationNode(t, `import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {createPrivateKey,createPublicKey,createHash} from 'node:crypto';import {verifyGalaxyGenesis} from './packages/galaxy-contracts/src/identity/galaxy-guid.mjs';const dir=process.argv[1],identity=JSON.parse(await readFile(join(dir,'galaxy-id.json'),'utf8')),pub=await readFile(join(dir,'galaxy-id-public-key.pem'),'utf8'),priv=await readFile(join(dir,'galaxy-id-private-key.pem'),'utf8');const fingerprint=createHash('sha256').update(pub).digest('hex').match(/.{1,4}/g).join(':');console.log(JSON.stringify({valid:verifyGalaxyGenesis(identity.id,identity.genesisProof)&&createPublicKey(createPrivateKey(priv)).export({type:'spki',format:'pem'})===pub&&identity.genesisProof.publicKeyPem===pub&&identity.publicKeyFingerprint===fingerprint}));`, dir)
	if check["valid"] != true {
		t.Fatal("shared Genesis contract or Node crypto rejected the identity")
	}
}
func nativeSourceShape(t *testing.T, name, owner string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "contracts", name))
	if err != nil {
		t.Fatal(err)
	}
	const fixtureOwner = "GUID1500000000000000000000000000"
	if name == "worker-source-v1.json" && !bytes.Contains(raw, []byte(fixtureOwner)) {
		t.Fatal("worker source fixture missing owner")
	}
	raw = []byte(strings.ReplaceAll(string(raw), fixtureOwner, owner))
	var result map[string]any
	if err = protocol.Decode(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func TestInitializationPreviewMatchesOriginalCatalogAndSelection(t *testing.T) {
	cases := []string{`{}`, `{"profile":"minimal"}`, `{"profile":"coding-case","subjectType":"organization"}`, `{"profile":"agent-workspace"}`, `{"modules":["agent-guidance"]}`, `{"modules":[]}`, `{"initializationPath":"personal-galaxy"}`, `{"initializationPath":"galaxy-worker"}`, `{"initializationPath":"galaxy-hub"}`, `{"uploadPrivacy":{"level":"conversation-archive","includeFullConversations":true,"sessionIds":[" one ","one"]}}`}
	fixture := readNativeContractFixture(t, "initialization-v1.json")
	for index, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			var input InitializationInput
			if e := protocol.Decode([]byte(raw), &input); e != nil {
				t.Fatal(e)
			}
			got, e := PreviewInitialization(input)
			if e != nil {
				t.Fatal(e)
			}
			want := uploadRows(fixture["previews"])[index]
			same(t, want, got)
		})
	}
	want := fixture["catalog"]
	same(t, want, InitializationCatalog())
	for _, input := range []InitializationInput{{Profile: "missing"}, {Modules: []string{"remote-sync"}}, {SubjectType: "agent"}, {InitializationPath: "personal-galaxy", Profile: "minimal"}} {
		if _, e := PreviewInitialization(input); e == nil {
			t.Fatal("invalid selection accepted")
		}
	}
}
func TestInitializationConfirmedLocalIdentityKeysAndModulesAreJSReadable(t *testing.T) {
	ctx := context.Background()
	dir := filepath.Join(t.TempDir(), "new-client")
	store, _ := NewStore(dir, "https://galaxy.invalid")
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.Initialize(ctx, InitializationInput{}, false, &scope); fault.Code(e) != "local_initialization_choice_required" {
		t.Fatal(e)
	}
	if _, e = os.Stat(dir); !os.IsNotExist(e) {
		t.Fatal("unconfirmed initialization created a directory")
	}
	result, e := store.Initialize(ctx, InitializationInput{SubjectType: "organization"}, true, &scope)
	if e != nil {
		t.Fatal(e)
	}
	if result["connectionCreated"] != false {
		t.Fatal(result)
	}
	mergedPlan, e := PreviewInitialization(InitializationInput{Modules: []string{"galaxy-id", "case-workspace", "consent-controls", "agent-mcp", "agent-guidance"}})
	if e != nil {
		t.Fatal(e)
	}
	same(t, mergedPlan, result["result"].(map[string]any)["plan"])
	local := result["result"].(map[string]any)["galaxyId"].(map[string]any)
	assertInitializationIdentity(t, dir, local)
	if local["subjectType"] != "organization" {
		t.Fatal(local)
	}
	statusValue, e := store.IntegrationStatus(ctx)
	if e != nil {
		t.Fatal(e)
	}
	status := statusValue.(map[string]any)
	if status["initialized"] != true || status["localOnly"] != true {
		t.Fatal(status)
	}
	before, e := os.ReadFile(filepath.Join(dir, "galaxy-id-private-key.pem"))
	if e != nil {
		t.Fatal(e)
	}
	identityBefore, _ := os.ReadFile(filepath.Join(dir, "galaxy-id.json"))
	currentScope, _ := store.ChoiceScope(ctx)
	second, e := store.Initialize(ctx, InitializationInput{InitializationPath: "personal-galaxy", SubjectType: "organization"}, true, &currentScope)
	if e != nil {
		t.Fatal(e)
	}
	if second["identity"] != result["identity"] {
		t.Fatal("identity rebuilt")
	}
	after, _ := os.ReadFile(filepath.Join(dir, "galaxy-id-private-key.pem"))
	identityAfter, _ := os.ReadFile(filepath.Join(dir, "galaxy-id.json"))
	if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(identityBefore, identityAfter) {
		t.Fatal("existing identity or key changed")
	}
	if _, e = store.Initialize(ctx, InitializationInput{SubjectType: "person"}, true, &currentScope); fault.Code(e) != "local_identity_type_immutable" {
		t.Fatal(e)
	}
	if _, e = store.Initialize(ctx, InitializationInput{}, true, &scope); fault.Code(e) != "native_choice_binding_changed" {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(dir, ".galaxy-initialization.json")); !os.IsNotExist(e) {
		t.Fatal("journal was not finalized")
	}
}
func TestInitializationJournalIsCompatibleWithOriginalRecoveryAndRefusesConflicts(t *testing.T) {
	dir := t.TempDir()
	record, e := initializationNew("person")
	if e != nil {
		t.Fatal(e)
	}
	raw, e := initializationPretty(record)
	if e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, ".galaxy-initialization.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(filepath.Join(dir, "galaxy-id-private-key.pem"), []byte(record.PrivateKeyPEM), 0600); e != nil {
		t.Fatal(e)
	}
	if e = initializationResume(dir); e != nil {
		t.Fatal(e)
	}
	var expected map[string]any
	if e = protocol.Decode(record.Identity, &expected); e != nil {
		t.Fatal(e)
	}
	assertInitializationIdentity(t, dir, expected)
	if e = initializationResume(dir); e != nil {
		t.Fatal(e)
	}
	conflict := t.TempDir()
	if e = os.WriteFile(filepath.Join(conflict, "galaxy-id-public-key.pem"), []byte("unrelated-existing-material"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = initializationPublish(conflict, record); fault.Code(e) != "local_initialization_file_conflict" {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(conflict, "galaxy-id-private-key.pem")); !os.IsNotExist(e) {
		t.Fatal("conflict wrote another file")
	}
	remnant := t.TempDir()
	if e = os.WriteFile(filepath.Join(remnant, "galaxy-id-public-key.pem"), []byte("preserve-remnant"), 0600); e != nil {
		t.Fatal(e)
	}
	store, _ := NewStore(remnant, "")
	if _, e = store.Initialize(context.Background(), InitializationInput{}, true, nil); fault.Code(e) != "local_initialization_incomplete" {
		t.Fatal(e)
	}
	planned := filepath.Join(t.TempDir(), "planned")
	store, _ = NewStore(planned, "")
	if _, e = store.Initialize(context.Background(), InitializationInput{InitializationPath: "galaxy-worker"}, true, nil); fault.Code(e) != "local_initialization_path_planned" {
		t.Fatal(e)
	}
	if _, e = os.Stat(planned); !os.IsNotExist(e) {
		t.Fatal("planned path created directory")
	}
}

func TestInitializationPreservesSelectedOtherIdentityAndOnlyStoresItsModules(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, _ := NewStore(dir, "https://galaxy.invalid")
	if _, e := store.Initialize(ctx, InitializationInput{Profile: "minimal"}, true, nil); e != nil {
		t.Fatal(e)
	}
	localBefore, _ := os.ReadFile(filepath.Join(dir, "galaxy-id.json"))
	stateBefore, _ := os.ReadFile(filepath.Join(dir, "galaxy-local-state.json"))
	other, e := initializationNew("person")
	if e != nil {
		t.Fatal(e)
	}
	var external map[string]any
	if e = protocol.Decode(other.Identity, &external); e != nil {
		t.Fatal(e)
	}
	active := map[string]any{"subjectId": external["id"], "deviceId": "selected-other-device", "installationId": "selected-other-installation", "genesisProof": external["genesisProof"]}
	if e = os.MkdirAll(filepath.Join(dir, "native-v2", "records"), 0700); e != nil {
		t.Fatal(e)
	}
	if e = writeJSON(connectionRecordPath(dir, "native-selection:"+store.Endpoint), map[string]any{"version": 1, "revision": 1, "active": active, "permission": nil}); e != nil {
		t.Fatal(e)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	out, e := store.Initialize(ctx, InitializationInput{Profile: "coding-case"}, true, &scope)
	if e != nil {
		t.Fatal(e)
	}
	if out["identity"] != external["id"] || out["existingIdentityPreserved"] != true {
		t.Fatal(out)
	}
	localAfter, _ := os.ReadFile(filepath.Join(dir, "galaxy-id.json"))
	stateAfter, _ := os.ReadFile(filepath.Join(dir, "galaxy-local-state.json"))
	if !reflect.DeepEqual(localBefore, localAfter) || !reflect.DeepEqual(stateBefore, stateAfter) {
		t.Fatal("other identity initialization changed original local files")
	}
	var saved map[string]any
	if _, e = readJSON(connectionRecordPath(dir, "native-modules:"+store.Endpoint+":"+text(external["id"])), &saved); e != nil {
		t.Fatal(e)
	}
	plan, e := PreviewInitialization(InitializationInput{Profile: "coding-case"})
	if e != nil {
		t.Fatal(e)
	}
	same(t, plan, saved["plan"])
}

func TestInitializationResumesOriginalJSJournalWithOriginalIdentity(t *testing.T) {
	directory := t.TempDir()
	record, raw := legacyInitializationFixture(t)
	if e := os.WriteFile(filepath.Join(directory, ".galaxy-initialization.json"), raw, 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(directory, "galaxy-id-private-key.pem"), []byte(record.PrivateKeyPEM), 0600); e != nil {
		t.Fatal(e)
	}
	var expected map[string]any
	if e := protocol.Decode(record.Identity, &expected); e != nil {
		t.Fatal(e)
	}
	store, _ := NewStore(directory, "")
	out, e := store.Initialize(context.Background(), InitializationInput{Profile: "minimal"}, true, nil)
	if e != nil {
		t.Fatal(e)
	}
	if out["identity"] != expected["id"] {
		t.Fatal("journal recovery changed identity")
	}
	assertInitializationIdentity(t, directory, expected)
	if _, e = os.Stat(filepath.Join(directory, ".galaxy-initialization.json")); !os.IsNotExist(e) {
		t.Fatal("recovery did not finish journal")
	}
	before, e := os.ReadFile(filepath.Join(directory, "galaxy-id-private-key.pem"))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = store.Initialize(context.Background(), InitializationInput{Profile: "minimal"}, true, nil); e != nil {
		t.Fatal(e)
	}
	after, e := os.ReadFile(filepath.Join(directory, "galaxy-id-private-key.pem"))
	if e != nil || !bytes.Equal(before, after) {
		t.Fatal("repeat initialization changed identity key")
	}
}
