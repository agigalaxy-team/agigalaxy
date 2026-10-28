package native

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
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
		t.Fatalf("initialization Node interop: %v: %s", e, output)
	}
	var result map[string]any
	if e = protocol.Decode(output, &result); e != nil {
		t.Fatalf("Node JSON: %v: %s", e, output)
	}
	return result
}
func TestInitializationPreviewMatchesOriginalCatalogAndSelection(t *testing.T) {
	cases := []string{`{}`, `{"profile":"minimal"}`, `{"profile":"coding-case","subjectType":"organization"}`, `{"profile":"agent-workspace"}`, `{"modules":["agent-guidance"]}`, `{"modules":[]}`, `{"initializationPath":"personal-galaxy"}`, `{"initializationPath":"galaxy-worker"}`, `{"initializationPath":"galaxy-hub"}`, `{"uploadPrivacy":{"level":"conversation-archive","includeFullConversations":true,"sessionIds":[" one ","one"]}}`}
	for _, raw := range cases {
		t.Run(raw, func(t *testing.T) {
			var input InitializationInput
			if e := protocol.Decode([]byte(raw), &input); e != nil {
				t.Fatal(e)
			}
			got, e := PreviewInitialization(input)
			if e != nil {
				t.Fatal(e)
			}
			want := initializationNode(t, `import {previewGalaxyIntegration} from './packages/galaxy-core/src/application/local-operations.mjs';console.log(JSON.stringify(previewGalaxyIntegration(JSON.parse(process.argv[1]))));`, raw)
			same(t, want, got)
		})
	}
	want := initializationNode(t, `import {listIntegrationModules} from './packages/galaxy-core/src/initialization/catalog.mjs';console.log(JSON.stringify(listIntegrationModules()));`)
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
	const script = `import {readFile} from 'node:fs/promises';import {join} from 'node:path';import {createPrivateKey,createPublicKey} from 'node:crypto';import {getLocalSnapshot,getGalaxyIntegrationStatus} from './packages/galaxy-core/src/application/local-operations.mjs';import {verifyGalaxyGenesis} from './packages/galaxy-core/src/galaxy-guid.mjs';import {fingerprint} from './packages/galaxy-core/src/domain/local-model.mjs';const dir=process.argv[1],snapshot=await getLocalSnapshot(dir),id=snapshot.identity,pub=await readFile(join(dir,'galaxy-id-public-key.pem'),'utf8'),priv=await readFile(join(dir,'galaxy-id-private-key.pem'),'utf8');if(!verifyGalaxyGenesis(id.id,id.genesisProof)||createPublicKey(createPrivateKey(priv)).export({type:'spki',format:'pem'})!==pub||fingerprint(pub)!==id.publicKeyFingerprint)throw Error('identity/key mismatch');console.log(JSON.stringify({snapshot,status:await getGalaxyIntegrationStatus(dir)}));`
	read := initializationNode(t, script, dir)
	snapshot := read["snapshot"].(map[string]any)
	same(t, result["result"].(map[string]any)["galaxyId"], snapshot["identity"])
	if snapshot["identity"].(map[string]any)["subjectType"] != "organization" {
		t.Fatal(read)
	}
	status := read["status"].(map[string]any)
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
	recovered := initializationNode(t, `import {resumeInitialization} from './packages/galaxy-core/src/storage/initialization.mjs';import {localPaths} from './packages/galaxy-core/src/storage/files.mjs';import {getLocalSnapshot} from './packages/galaxy-core/src/application/local-operations.mjs';await resumeInitialization(localPaths(process.argv[1]));console.log(JSON.stringify(await getLocalSnapshot(process.argv[1])));`, dir)
	if !connectionGenesis(text(recovered["identity"].(map[string]any)["id"]), initializationMap(recovered["identity"].(map[string]any)["genesisProof"])) {
		t.Fatal("Node could not recover original Go identity")
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
	read := initializationNode(t, `import {join} from 'node:path';import {mkdir,readFile} from 'node:fs/promises';import {initializeLocalGalaxyId} from './packages/galaxy-core/src/application/local-operations.mjs';import {publishInitialization} from './packages/galaxy-core/src/storage/initialization.mjs';import {localPaths} from './packages/galaxy-core/src/storage/files.mjs';const root=process.argv[1],seed=join(root,'seed'),dest=join(root,'pending');const first=await initializeLocalGalaxyId(seed,{subjectType:'person'});await mkdir(dest);const paths=localPaths(seed);const record={version:1,identity:first.identity,privateKeyPem:await readFile(paths.privateKey,'utf8'),publicKeyPem:await readFile(paths.publicKey,'utf8'),state:first.state};try{await publishInitialization(localPaths(dest),record,async phase=>{if(phase==='private-key')throw Error('synthetic interruption');});}catch(error){if(error.message!=='synthetic interruption')throw error;}console.log(JSON.stringify({id:first.identity.id}));`, directory)
	store, _ := NewStore(filepath.Join(directory, "pending"), "")
	out, e := store.Initialize(context.Background(), InitializationInput{Profile: "minimal"}, true, nil)
	if e != nil {
		t.Fatal(e)
	}
	if out["identity"] != read["id"] {
		t.Fatal("journal recovery changed identity")
	}
	if _, e = os.Stat(filepath.Join(store.Directory, ".galaxy-initialization.json")); !os.IsNotExist(e) {
		t.Fatal("recovery did not finish journal")
	}
}
