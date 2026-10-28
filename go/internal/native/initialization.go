package native

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
)

// Selection matches the existing Native initialization tool. Confirmation and
// the captured scope are separate trusted-call arguments, never model fields.
type InitializationInput struct {
	InitializationPath string                  `json:"initializationPath,omitempty"`
	Profile            string                  `json:"profile,omitempty"`
	Modules            []string                `json:"modules,omitempty"`
	SubjectType        string                  `json:"subjectType,omitempty"`
	UploadPrivacy      *UploadPrivacySelection `json:"uploadPrivacy,omitempty"`
}

func InitializationCatalog() map[string]any {
	var result map[string]any
	_ = protocol.Decode([]byte(initializationCatalogJSON), &result)
	return result
}
func initializationArray(value any) []any {
	result, _ := value.([]any)
	if result == nil {
		return []any{}
	}
	return result
}
func initializationStrings(value any) []string {
	result := []string{}
	for _, item := range initializationArray(value) {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result
}
func initializationContains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
func initializationError() error { return fault.New("local_initialization_input_invalid", 400) }
func initializationModules(modules []string, profile string) (map[string]any, error) {
	catalog := InitializationCatalog()
	definitions := map[string]map[string]any{}
	defaults := []string{}
	for _, value := range initializationArray(catalog["modules"]) {
		m := value.(map[string]any)
		definitions[text(m["id"])] = m
		if m["defaultSelected"] == true {
			defaults = append(defaults, text(m["id"]))
		}
	}
	explicit := []string{}
	if profile != "" {
		profiles := catalog["profiles"].(map[string]any)
		p, ok := profiles[profile]
		if !ok || len(modules) > 0 {
			return nil, initializationError()
		}
		explicit = initializationStrings(p)
	} else {
		for _, value := range modules {
			value = strings.TrimSpace(value)
			if value != "" && !initializationContains(explicit, value) {
				explicit = append(explicit, value)
			}
		}
	}
	requested := append([]string{}, explicit...)
	if len(requested) == 0 {
		requested = append([]string{}, defaults...)
	}
	resolved := []string{}
	implied := map[string][]string{}
	var add func(string, string) error
	add = func(id, requiredBy string) error {
		m, ok := definitions[id]
		if !ok || m["availability"] != "available" {
			return initializationError()
		}
		for _, dependency := range initializationStrings(m["requires"]) {
			if e := add(dependency, id); e != nil {
				return e
			}
		}
		if !initializationContains(resolved, id) {
			resolved = append(resolved, id)
		}
		if requiredBy != "" && !initializationContains(explicit, id) && !initializationContains(implied[id], requiredBy) {
			implied[id] = append(implied[id], requiredBy)
		}
		return nil
	}
	for _, id := range requested {
		if e := add(id, ""); e != nil {
			return nil, e
		}
	}
	selected := []any{}
	for _, id := range resolved {
		m := definitions[id]
		dependencies := implied[id]
		if dependencies == nil {
			dependencies = []string{}
		}
		m["impliedBy"] = dependencies
		selected = append(selected, m)
	}
	var selectedProfile any
	if profile != "" {
		selectedProfile = profile
	}
	return map[string]any{"profile": selectedProfile, "requestedModuleIds": requested, "modules": selected, "localOnly": true, "remoteEffects": "none", "notes": []string{"Initialization writes only local configuration and, when Galaxy ID is selected, local key material.", "No selected module uploads Case content, publishes Proof, creates a remote account, or enables remote sync."}}, nil
}
func initializationPlan(input InitializationInput, allowPlanned bool) (map[string]any, error) {
	if input.SubjectType != "" && input.SubjectType != "person" && input.SubjectType != "organization" {
		return nil, fault.New("local_identity_subject_type_invalid", 400)
	}
	if len(input.Modules) > 8 {
		return nil, initializationError()
	}
	for _, id := range input.Modules {
		if len(id) < 2 || len(id) > 80 {
			return nil, initializationError()
		}
	}
	privacy := NormalizeUploadPrivacy(nil)
	if input.UploadPrivacy != nil {
		var e error
		privacy, e = SelectUploadPrivacy(privacy, *input.UploadPrivacy, "")
		if e != nil {
			return nil, e
		}
	}
	subject := input.SubjectType
	if subject == "" {
		subject = "person"
	}
	pathID := input.InitializationPath
	if pathID == "" && input.Modules == nil && input.Profile == "" {
		pathID = "personal-galaxy"
	}
	if pathID == "" {
		plan, e := initializationModules(input.Modules, input.Profile)
		if e != nil {
			return nil, e
		}
		plan["initializationPath"] = nil
		plan["operation"] = "module-change"
		plan["subjectType"] = subject
		plan["uploadPrivacy"] = privacy
		return plan, nil
	}
	if input.Profile != "" || len(input.Modules) > 0 {
		return nil, initializationError()
	}
	var selected map[string]any
	for _, value := range initializationArray(InitializationCatalog()["initializationPaths"]) {
		path := value.(map[string]any)
		if path["id"] == strings.TrimSpace(pathID) {
			selected = path
			break
		}
	}
	if selected == nil {
		return nil, initializationError()
	}
	if _, ok := selected["futureCapabilityIds"]; !ok {
		selected["futureCapabilityIds"] = []any{}
	}
	if selected["availability"] != "available" {
		if !allowPlanned {
			return nil, fault.New("local_initialization_path_planned", 400)
		}
		return map[string]any{"profile": nil, "requestedModuleIds": []string{}, "modules": []any{}, "localOnly": true, "remoteEffects": "none", "notes": []string{"This is a read-only architecture preview. No runtime, local configuration, or Galaxy ID will be created.", text(selected["title"]) + " is planned and cannot be initialized in Founding Beta."}, "initializationPath": selected, "operation": "future-path-preview", "canInitialize": false}, nil
	}
	plan, e := initializationModules(initializationStrings(selected["moduleIds"]), "")
	if e != nil {
		return nil, e
	}
	plan["capabilityProfile"] = "l3-foundation"
	plan["initializationPath"] = selected
	plan["operation"] = "first-run-or-path-change"
	plan["canInitialize"] = true
	plan["subjectType"] = subject
	plan["uploadPrivacy"] = privacy
	return plan, nil
}
func PreviewInitialization(input InitializationInput) (map[string]any, error) {
	return initializationPlan(input, true)
}
func initializationTime() string { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func initializationAudit(state map[string]any, action, subject, at string, details any) {
	events := initializationArray(state["auditEvents"])
	state["auditEvents"] = append(events, map[string]any{"id": "audit_" + strings.ReplaceAll(uuid.NewString(), "-", ""), "action": action, "subjectId": subject, "occurredAt": at, "details": details})
}
func initializationState() map[string]any {
	return map[string]any{"version": 2, "integration": nil, "uploadPrivacy": NormalizeUploadPrivacy(nil), "cases": []any{}, "disclosurePlans": []any{}, "consentGrants": []any{}, "localProofDrafts": []any{}, "auditEvents": []any{}}
}
func initializationNormalize(state map[string]any) map[string]any {
	if state == nil {
		state = initializationState()
	}
	state["version"] = 2
	for _, key := range []string{"cases", "disclosurePlans", "consentGrants", "localProofDrafts", "auditEvents"} {
		state[key] = initializationArray(state[key])
	}
	state["uploadPrivacy"] = NormalizeUploadPrivacy(state["uploadPrivacy"])
	integration, ok := state["integration"].(map[string]any)
	if !ok {
		state["integration"] = nil
	} else if _, ok := integration["modules"].([]any); !ok {
		state["integration"] = nil
	}
	return state
}

// Initialize writes only the configured local directory under the existing
// cross-process lock. It never starts a connection, upload, model or helper.
func (s *Store) Initialize(ctx context.Context, input InitializationInput, confirmed bool, expected *ChoiceScope) (map[string]any, error) {
	if !confirmed {
		return nil, fault.New("local_initialization_choice_required", 403)
	}
	plan, e := initializationPlan(input, false)
	if e != nil {
		return nil, e
	}
	var out map[string]any
	e = s.With(ctx, true, func(dir string) error {
		if e := s.verifyChoiceWithin(dir, expected); e != nil {
			return e
		}
		if present, e := exists(filepath.Join(dir, ".galaxy-reset.json")); e != nil {
			return e
		} else if present {
			return fault.New("local_initialization_requires_recovery", 409)
		}
		// An explicitly trusted recovery call may resume the validated original
		// journal. A captured ordinary choice still rejects a journal appearing
		// after the preview through verifyChoiceWithin above.
		if expected == nil {
			if e := initializationResume(dir); e != nil {
				return e
			}
		}
		var local map[string]any
		if e := readFallback(dir, "galaxy-id.json", "node.json", &local); e != nil {
			return e
		}
		owner, e := s.ownerWithin(dir, "")
		if e != nil {
			return e
		}
		// The currently selected imported identity only gets its own module record.
		// It must never acquire a new genesis key or rewrite the local genesis ID.
		if owner != "" && owner != text(local["id"]) {
			directory := filepath.Join(dir, "native-v2", "records")
			if e := os.MkdirAll(directory, 0700); e != nil {
				return e
			}
			if e := writeJSON(connectionRecordPath(dir, "native-modules:"+s.Endpoint+":"+owner), map[string]any{"plan": plan, "selectedAt": initializationTime()}); e != nil {
				return e
			}
			out = map[string]any{"initialized": true, "localOnly": true, "identity": owner, "connectionCreated": false, "result": plan, "existingIdentityPreserved": true}
			return nil
		}
		if e := initializationMigrate(dir); e != nil {
			return e
		}
		if e := initializationResume(dir); e != nil {
			return e
		}
		local = nil
		_, e = readJSON(filepath.Join(dir, "galaxy-id.json"), &local)
		if e != nil {
			return e
		}
		if local != nil {
			if input.SubjectType != "" && local["subjectType"] != input.SubjectType {
				code := "local_identity_type_immutable"
				if text(local["subjectType"]) == "" {
					code = "local_identity_legacy_type_unconfirmed"
				}
				return fault.New(code, 409)
			}
			if kind := text(local["clientKind"]); kind != "" && kind != "normal" {
				return fault.New("local_identity_client_kind_mismatch", 409)
			}
		} else {
			for _, name := range []string{"galaxy-id-private-key.pem", "galaxy-id-public-key.pem", "galaxy-local-state.json"} {
				if present, e := exists(filepath.Join(dir, name)); e != nil {
					return e
				} else if present {
					return fault.New("local_initialization_incomplete", 409)
				}
			}
			record, e := initializationNew(input.SubjectType)
			if e != nil {
				return e
			}
			if e = initializationPublish(dir, record); e != nil {
				return e
			}
			if e = protocol.Decode(record.Identity, &local); e != nil {
				return e
			}
		}
		state := map[string]any{}
		present, e := readJSON(filepath.Join(dir, "galaxy-local-state.json"), &state)
		if e != nil {
			return e
		}
		if !present {
			state = initializationState()
			initializationAudit(state, "galaxy_id.initialized", text(local["id"]), initializationTime(), map[string]any{"localOnly": true})
		}
		state = initializationNormalize(state)
		at := initializationTime()
		prior, _ := state["integration"].(map[string]any)
		current := initializationArray(prior["modules"])
		currentIDs := []string{}
		currentByID := map[string]map[string]any{}
		for _, item := range current {
			m, ok := item.(map[string]any)
			if !ok {
				return fault.New("local_initialization_incomplete", 409)
			}
			id := text(m["id"])
			currentIDs = append(currentIDs, id)
			currentByID[id] = m
		}
		mergeIDs := append([]string{}, currentIDs...)
		for _, item := range initializationArray(plan["modules"]) {
			id := text(item.(map[string]any)["id"])
			if !initializationContains(mergeIDs, id) {
				mergeIDs = append(mergeIDs, id)
			}
		}
		merged, e := initializationPlan(InitializationInput{Modules: mergeIDs}, false)
		if e != nil {
			return e
		}
		if input.UploadPrivacy != nil {
			p, e := SelectUploadPrivacy(NormalizeUploadPrivacy(state["uploadPrivacy"]), *input.UploadPrivacy, at)
			if e != nil {
				return e
			}
			state["uploadPrivacy"] = p
		}
		requested := []string{}
		switch ids := plan["requestedModuleIds"].(type) {
		case []string:
			requested = ids
		case []any:
			requested = initializationStrings(ids)
		}
		modules := []any{}
		added := []string{}
		snapshot := []string{}
		for _, item := range initializationArray(merged["modules"]) {
			id := text(item.(map[string]any)["id"])
			old := currentByID[id]
			enabledAt := any(at)
			explicit := any(initializationContains(requested, id))
			if old != nil {
				if old["enabledAt"] != nil {
					enabledAt = old["enabledAt"]
				}
				if old["selectedExplicitly"] != nil {
					explicit = old["selectedExplicitly"]
				}
			}
			modules = append(modules, map[string]any{"id": id, "enabledAt": enabledAt, "selectedExplicitly": explicit})
			snapshot = append(snapshot, id)
			if !initializationContains(currentIDs, id) {
				added = append(added, id)
			}
		}
		path := plan["initializationPath"]
		if path == nil {
			path = prior["initializationPath"]
		}
		priorPath, _ := prior["initializationPath"].(map[string]any)
		nextPath, _ := path.(map[string]any)
		var from, to any
		if priorPath != nil {
			from = priorPath["id"]
		}
		if nextPath != nil {
			to = nextPath["id"]
		}
		kind := "first-initialization"
		if prior != nil {
			kind = "configuration-change"
		}
		change := map[string]any{"kind": kind, "fromInitializationPathId": from, "toInitializationPathId": to}
		initializedAt := prior["initializedAt"]
		if initializedAt == nil {
			initializedAt = at
		}
		capability := plan["capabilityProfile"]
		if capability == nil {
			capability = prior["capabilityProfile"]
		}
		enabledSnapshot := prior["enabledModuleSnapshot"]
		if plan["capabilityProfile"] != nil {
			enabledSnapshot = snapshot
		}
		connection := prior["connectionProfile"]
		if connection == nil && plan["capabilityProfile"] != nil {
			connection = map[string]any{"version": 1, "capabilityProfile": "l3-foundation", "targets": []any{}, "scopes": []any{}, "audit": []any{map[string]any{"at": at, "action": "profile-created"}}}
		}
		integration := map[string]any{"version": 2, "initializedAt": initializedAt, "updatedAt": at, "source": "native-v2", "profile": plan["profile"], "capabilityProfile": capability, "enabledModuleSnapshot": enabledSnapshot, "connectionProfile": connection, "initializationPath": path, "lastChange": map[string]any{"kind": kind, "fromInitializationPathId": from, "toInitializationPathId": to, "occurredAt": at}, "modules": modules, "localOnly": true, "remoteEffects": "none"}
		state["integration"] = integration
		initializationAudit(state, "integration.initialized", text(local["id"]), at, map[string]any{"capabilityProfile": capability, "requestedModuleIds": plan["requestedModuleIds"], "addedModuleIds": added, "initializationPathId": to, "change": change, "localOnly": true})
		if e = writeJSON(filepath.Join(dir, "galaxy-local-state.json"), state); e != nil {
			return e
		}
		if !connectionGenesis(text(local["id"]), initializationMap(local["genesisProof"])) {
			return fault.New("local_identity_required", 409)
		}
		result := map[string]any{"dataDir": dir, "galaxyId": local, "integration": integration, "uploadPrivacy": state["uploadPrivacy"], "addedModuleIds": added, "plan": merged, "change": change, "localOnly": true}
		out = map[string]any{"initialized": true, "localOnly": true, "identity": local["id"], "connectionCreated": false, "result": result}
		return nil
	})
	return out, e
}
func initializationMap(v any) map[string]any { m, _ := v.(map[string]any); return m }

type initializationRecord struct {
	Version       int             `json:"version"`
	Identity      json.RawMessage `json:"identity"`
	PrivateKeyPEM string          `json:"privateKeyPem"`
	PublicKeyPEM  string          `json:"publicKeyPem"`
	State         json.RawMessage `json:"state"`
}

func initializationPretty(v any) ([]byte, error) {
	b, e := json.MarshalIndent(v, "", "  ")
	return append(b, '\n'), e
}
func initializationMigrate(dir string) error {
	for _, pair := range [][2]string{{"node.json", "galaxy-id.json"}, {"node-private-key.pem", "galaxy-id-private-key.pem"}, {"node-public-key.pem", "galaxy-id-public-key.pem"}, {"local-state.json", "galaxy-local-state.json"}} {
		old, new := filepath.Join(dir, pair[0]), filepath.Join(dir, pair[1])
		present, e := exists(new)
		if e != nil {
			return e
		}
		if present {
			continue
		}
		present, e = exists(old)
		if e != nil {
			return e
		}
		if present {
			if e = os.Rename(old, new); e != nil {
				return e
			}
		}
	}
	return nil
}
func initializationValidate(record initializationRecord) error {
	var local, state map[string]any
	if record.Version != 1 || protocol.Decode(record.Identity, &local) != nil || protocol.Decode(record.State, &state) != nil || !connectionGenesis(text(local["id"]), initializationMap(local["genesisProof"])) || initializationMap(local["genesisProof"])["publicKeyPem"] != record.PublicKeyPEM {
		return fault.New("local_initialization_journal_invalid", 409)
	}
	private, e := identity.PrivatePEM([]byte(record.PrivateKeyPEM))
	if e != nil {
		return fault.New("local_initialization_journal_invalid", 409)
	}
	public, e := identity.PublicPEM(private.Public().(ed25519.PublicKey))
	events := initializationArray(state["auditEvents"])
	if e != nil || public != record.PublicKeyPEM || len(events) != 1 {
		return fault.New("local_initialization_journal_invalid", 409)
	}
	event := initializationMap(events[0])
	if event["subjectId"] != local["id"] || event["action"] != "galaxy_id.initialized" {
		return fault.New("local_initialization_journal_invalid", 409)
	}
	return nil
}
func initializationWrite(path string, bytes []byte) error {
	f, e := os.CreateTemp(filepath.Dir(path), ".galaxy-init-*.tmp")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(bytes)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	return os.Rename(name, path)
}
func initializationPublish(dir string, record initializationRecord) error {
	if e := initializationValidate(record); e != nil {
		return e
	}
	journal := filepath.Join(dir, ".galaxy-initialization.json")
	raw, e := initializationPretty(record)
	if e != nil {
		return e
	}
	saved, e := os.ReadFile(journal)
	if e != nil && !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if e == nil && !reflect.DeepEqual(saved, raw) {
		return fault.New("local_initialization_journal_conflict", 409)
	}
	identityBytes := append(json.RawMessage{}, record.Identity...)
	stateBytes := append(json.RawMessage{}, record.State...)
	var identityPretty, statePretty any
	if e = protocol.Decode(identityBytes, &identityPretty); e != nil {
		return e
	}
	if e = protocol.Decode(stateBytes, &statePretty); e != nil {
		return e
	}
	// RawMessage keeps original JSON object ordering for Node's recovery checker.
	ip, e := initializationPretty(identityBytes)
	if e != nil {
		return e
	}
	sp, e := initializationPretty(stateBytes)
	if e != nil {
		return e
	}
	files := []struct {
		name  string
		bytes []byte
	}{{"galaxy-id-private-key.pem", []byte(record.PrivateKeyPEM)}, {"galaxy-id-public-key.pem", []byte(record.PublicKeyPEM)}, {"galaxy-local-state.json", sp}, {"galaxy-id.json", ip}}
	present := make([]bool, len(files))
	for i, file := range files {
		current, e := os.ReadFile(filepath.Join(dir, file.name))
		if e == nil {
			if !reflect.DeepEqual(current, file.bytes) {
				return fault.New("local_initialization_file_conflict", 409)
			}
			present[i] = true
		} else if !errors.Is(e, os.ErrNotExist) {
			return e
		}
	}
	if saved == nil {
		if e = initializationWrite(journal, raw); e != nil {
			return e
		}
	}
	for i, file := range files {
		if !present[i] {
			if e = initializationWrite(filepath.Join(dir, file.name), file.bytes); e != nil {
				return e
			}
		}
	}
	return os.Remove(journal)
}
func initializationResume(dir string) error {
	path := filepath.Join(dir, ".galaxy-initialization.json")
	info, e := os.Stat(path)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	if !info.Mode().IsRegular() || info.Size() > 32768 || runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return fault.New("local_initialization_journal_invalid", 409)
	}
	bytes, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	var record initializationRecord
	if e = protocol.Decode(bytes, &record); e != nil {
		return fault.New("local_initialization_journal_invalid", 409)
	}
	return initializationPublish(dir, record)
}
func initializationBase32(value *big.Int, length int) string {
	alphabet := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	out := make([]byte, length)
	value = new(big.Int).Set(value)
	mask := big.NewInt(31)
	for i := length - 1; i >= 0; i-- {
		out[i] = alphabet[new(big.Int).And(value, mask).Int64()]
		value.Rsh(value, 5)
	}
	return string(out)
}
func initializationNew(subject string) (initializationRecord, error) {
	if subject == "" {
		subject = "person"
	}
	public, private, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		return initializationRecord{}, e
	}
	pub, e := identity.PublicPEM(public)
	if e != nil {
		return initializationRecord{}, e
	}
	der, e := x509.MarshalPKCS8PrivateKey(private)
	if e != nil {
		return initializationRecord{}, e
	}
	priv := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	nonce := make([]byte, 32)
	if _, e = rand.Read(nonce); e != nil {
		return initializationRecord{}, e
	}
	at := initializationTime()
	when, e := time.Parse(time.RFC3339Nano, at)
	if e != nil {
		return initializationRecord{}, e
	}
	ms := when.UnixMilli()
	preimage := append([]byte("galaxy/guid/v1\x000\x00"+big.NewInt(ms).String()+"\x00"+strings.TrimSpace(pub)+"\x00"), nonce...)
	digest := sha256.Sum256(preimage)
	id := "GUID10" + initializationBase32(big.NewInt(ms), 10) + initializationBase32(new(big.Int).SetBytes(digest[:10]), 16)
	fingerprint := identity.Digest([]byte(pub))
	parts := []string{}
	for i := 0; i < len(fingerprint); i += 4 {
		parts = append(parts, fingerprint[i:i+4])
	}
	local := map[string]any{"version": 2, "id": id, "genesisProof": map[string]any{"version": 1, "publicKeyPem": pub, "nonce": base64.RawURLEncoding.EncodeToString(nonce)}, "idFormat": "guid-32-v1", "birthOrigin": "local", "birthOriginCode": "0", "subjectType": subject, "clientKind": "normal", "publicKeyFingerprint": strings.Join(parts, ":"), "keyAlgorithm": "Ed25519", "createdAt": at, "localOnly": true, "transport": "none", "note": "This Galaxy ID was created locally. It has not been registered, verified, or uploaded."}
	state := initializationState()
	initializationAudit(state, "galaxy_id.initialized", id, at, map[string]any{"localOnly": true})
	ib, e := protocol.Encode(local)
	if e != nil {
		return initializationRecord{}, e
	}
	sb, e := protocol.Encode(state)
	if e != nil {
		return initializationRecord{}, e
	}
	return initializationRecord{1, ib, priv, pub, sb}, nil
}
