package native

import (
	"context"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"strings"
)

type CommandInput struct {
	Command  string `json:"command,omitempty"`
	Language string `json:"language,omitempty"`
	Stage    int    `json:"stage,omitempty"`
}

func commandTemplates() map[string]any {
	var value map[string]any
	_ = protocol.Decode([]byte(commandContractsJSON), &value)
	return value
}
func commandNativeReferences(value any) any {
	switch node := value.(type) {
	case map[string]any:
		for key, value := range node {
			node[key] = commandNativeReferences(value)
		}
		return node
	case []any:
		for i, value := range node {
			node[i] = commandNativeReferences(value)
		}
		return node
	case string:
		switch node {
		case "galaxy_integration_preview_initialization":
			return "galaxy_native_initialize_preview"
		case "galaxy_integration_initialize":
			return "galaxy_native_initialize"
		case "galaxy_connection_preview":
			return "galaxy_native_connect"
		case "galaxy_connection_status":
			return "galaxy_native_status"
		}
		return node
	}
	return value
}
func CommandInitialization(input CommandInput) map[string]any {
	templates := commandTemplates()
	language := "zh-CN"
	if input.Language == "en-US" {
		language = "en-US"
	}
	stage := input.Stage
	if stage < 1 || stage > 5 {
		stage = 1
	}
	key := language
	if input.Language == "" {
		key = "language-selection"
	}
	contract := uploadObject(uploadObject(templates["initialization"])[key])
	if input.Language != "" {
		uploadObject(contract["progress"])["current"] = stage
		contract["currentStage"] = uploadObject(uploadRows(contract["stages"])[stage-1])
	}
	presentation := uploadObject(uploadObject(templates["presentation"])[language])
	footer := uploadObject(presentation["footer"])
	footer["stage"] = stage
	text := text(footer["progressText"])
	if language == "en-US" {
		footer["progressText"] = strings.Replace(text, "Step 1 /", fmt.Sprintf("Step %d /", stage), 1)
	} else {
		footer["progressText"] = strings.Replace(text, "阶段 1 /", fmt.Sprintf("阶段 %d /", stage), 1)
	}
	return commandNativeReferences(map[string]any{"initializationContract": contract, "initializationPresentation": presentation}).(map[string]any)
}
func integrationStatus(snapshot map[string]any) map[string]any {
	state := uploadObject(snapshot["state"])
	integration := uploadObject(state["integration"])
	return map[string]any{"dataDir": snapshot["dataDir"], "initialized": integration != nil, "recoveryRequired": snapshot["recoveryRequired"] == true, "galaxyId": snapshot["identity"], "integration": state["integration"], "uploadPrivacy": NormalizeUploadPrivacy(state["uploadPrivacy"]), "catalog": InitializationCatalog()["modules"], "recordCounts": map[string]any{"cases": len(uploadRows(state["cases"])), "disclosurePlans": len(uploadRows(state["disclosurePlans"])), "consentGrants": len(uploadRows(state["consentGrants"])), "localProofDrafts": len(uploadRows(state["localProofDrafts"])), "auditEvents": len(uploadRows(state["auditEvents"]))}, "localOnly": true}
}
func (s *Store) IntegrationStatus(ctx context.Context) (any, error) {
	snapshot, e := s.LocalSnapshot(ctx)
	if e != nil {
		return nil, e
	}
	return integrationStatus(snapshot), nil
}
func (r *Runtime) Command(ctx context.Context, input CommandInput) (any, error) {
	name := strings.ToLower(uploadTrim(input.Command))
	if name == "" {
		name = "open"
	}
	templates := commandTemplates()
	definition := uploadObject(uploadObject(templates["commands"])[name])
	if definition == nil {
		return nil, fault.New("native_command_unknown", 400)
	}
	operation, cancel, generation, e := r.operation(ctx, false)
	if e != nil {
		return nil, e
	}
	defer cancel()
	var snapshot map[string]any
	var scope ChoiceScope
	e = r.store.With(operation, false, func(dir string) error {
		var e error
		snapshot, e = localSnapshotWithin(dir)
		if e != nil {
			return e
		}
		if snapshot["recoveryRequired"] != true {
			scope, e = r.store.choiceScopeWithin(dir)
		}
		return e
	})
	if e != nil {
		return nil, e
	}
	if snapshot["recoveryRequired"] == true {
		return map[string]any{"command": name, "route": "galaxy-local-recovery", "state": "recovery-required", "title": "Local Galaxy recovery required", "message": "A local initialization or reset was interrupted. Preserve the local files and explicitly resume initialization or reset after reviewing the pending operation. This read performs no recovery.", "recoveryRequired": true, "nextTools": []string{}, "localOnly": true}, nil
	}
	value, e := r.commandSurface(operation, name, input, templates, definition, snapshot, scope)
	if e != nil {
		return nil, e
	}
	if e = r.checkOperation(generation); e != nil {
		return nil, e
	}
	e = r.store.With(operation, false, func(dir string) error { return r.store.verifyChoiceWithin(dir, &scope) })
	return value, e
}
func (r *Runtime) commandSurface(ctx context.Context, name string, input CommandInput, templates, definition, snapshot map[string]any, scope ChoiceScope) (any, error) {
	// These original Native overrides use the current selected identity, including
	// an adopted identity. They never fall back to another local identity's work.
	if name == "worker" {
		return map[string]any{"command": name, "route": "galaxy-worker-identity", "state": "identity-setup-available", "message": "通过独立 Worker 目录创建 Agent 主体，保留普通客户端身份与履历；本操作不启动 Worker 或模型。", "nextTools": []string{"galaxy_local_worker_identity_create"}, "runtimeStarted": false, "localOnly": true}, nil
	}
	if name == "history" || name == "work" {
		history, e := r.store.WorkList(ctx, WorkQuery{GalaxyID: scope.Owner})
		if e != nil {
			return nil, e
		}
		return map[string]any{"command": name, "route": "galaxy-work-history", "state": "ready", "history": history, "nextTools": []string{"galaxy_local_work_get", "galaxy_local_work_pending", "galaxy_local_work_summary", "galaxy_local_work_note"}, "localOnly": true}, nil
	}
	if name == "privacy" {
		settings, owner, e := r.ReadUploadPrivacy(ctx, &scope)
		if e != nil {
			return nil, e
		}
		privacy := map[string]any{"galaxyId": nullableText(owner), "initialized": owner != "", "recoveryRequired": false, "settings": settings, "levels": uploadPrivacyLevelsWithDefault(), "allowedDataTypes": AllowedUploadDataTypes(settings), "uploadStarted": false, "changesOnlineVisibility": false, "localOnly": true}
		return map[string]any{"command": name, "route": "galaxy-privacy-controls", "state": "ready", "privacy": privacy, "nextTools": []string{"galaxy_local_upload_privacy_set", "galaxy_local_archive_settings", "galaxy_local_archive_list"}, "localOnly": true}, nil
	}
	local := uploadObject(snapshot["identity"])
	if scope.Owner != "" && scope.Owner != text(local["id"]) {
		status, e := r.Status(ctx, RuntimeStatusOptions{})
		if e != nil {
			return nil, e
		}
		status["command"], status["interface"], status["identityAlreadyAdopted"], status["instruction"] = name, "chat", true, "Use this adopted identity. Setup changes local modules only; do not create another GUID. Full rooms open through galaxy_open."
		return status, nil
	}
	route, title := definition["route"], definition["title"]
	paths := InitializationCatalog()["initializationPaths"]
	switch name {
	case "connect":
		status, e := r.Status(ctx, RuntimeStatusOptions{})
		if e != nil {
			return nil, e
		}
		state := "not-connected"
		if status["connected"] == true {
			state = "connected"
		}
		return map[string]any{"command": name, "route": route, "state": state, "title": title, "connectionContract": status, "nextTools": []string{"galaxy_native_connect", "galaxy_native_status"}, "localOnly": true}, nil
	case "help":
		return map[string]any{"command": name, "state": "ready", "route": route, "title": title, "message": "Choose a Galaxy command. Commands do not create a Galaxy ID unless the final initialization confirmation is completed.", "commands": templates["help"], "localOnly": true}, nil
	case "language":
		return map[string]any{"command": name, "state": "language-selection", "route": route, "title": title, "message": "Choose the display language for this Galaxy interaction. This choice is not stored in your Galaxy ID or local initialization state.", "initializationContract": CommandInitialization(CommandInput{})["initializationContract"], "localOnly": true}, nil
	case "website":
		return map[string]any{"command": name, "state": "website-entry", "route": route, "title": title, "message": "Use the explicitly configured official website in your host. This local command does not open a browser.", "website": r.config.Website, "opened": false, "nextTools": []string{}, "localOnly": true}, nil
	}
	status := integrationStatus(snapshot)
	integration := uploadObject(status["integration"])
	if status["initialized"] != true {
		if name == "status" {
			message := "Galaxy is not initialized on this device. No Galaxy ID, remote account, sync, Worker, Hub, or uploaded data exists."
			if local != nil {
				message = "A local Galaxy ID already exists. Integration modules are not initialized; this read creates no identity, connection or upload."
			}
			return map[string]any{"command": name, "state": "not-initialized", "route": route, "title": title, "message": message, "initializationPaths": paths, "nextTools": []string{"galaxy_command", "galaxy_native_initialize_preview"}, "localOnly": true}, nil
		}
		value := map[string]any{"command": name, "state": "needs-initialization", "route": "galaxy-initialization", "title": "Set up Galaxy once", "message": "Galaxy has not been initialized on this device. Choose an initialization path, preview its local effects, then confirm once.", "initializationPaths": paths, "nextTools": []string{"galaxy_native_initialize_preview", "galaxy_native_initialize"}, "localOnly": true}
		if local != nil {
			value["message"] = "A local Galaxy ID already exists. Review and confirm the local module configuration without creating another ID."
		}
		for key, field := range CommandInitialization(input) {
			value[key] = field
		}
		return value, nil
	}
	enabled := map[string]bool{}
	for _, value := range uploadRows(integration["modules"]) {
		module, ok := value.(map[string]any)
		if !ok {
			return nil, fault.New("native_local_state_invalid", 409)
		}
		enabled[text(module["id"])] = true
	}
	if future := text(definition["futurePath"]); future != "" {
		for _, value := range uploadRows(paths) {
			path := uploadObject(value)
			if path["id"] == future {
				return map[string]any{"command": name, "state": "planned-service", "route": "galaxy-configuration-change", "title": path["title"], "message": text(path["title"]) + " is a future initialization path. The current local Galaxy remains active; no Worker or Hub runtime has been created.", "currentInitializationPath": integration["initializationPath"], "requestedInitializationPath": path, "nextTools": []string{"galaxy_native_initialize_preview"}, "localOnly": true}, nil
			}
		}
	}
	missing := []string{}
	for _, required := range mustUploadStrings(definition["requires"]) {
		if !enabled[required] {
			missing = append(missing, required)
		}
	}
	if len(missing) > 0 {
		return map[string]any{"command": name, "state": "needs-configuration-change", "route": "galaxy-configuration-change", "title": title, "message": "This local Galaxy is initialized, but the requested service is not enabled. Preview a configuration change before enabling it.", "missingModules": missing, "currentInitializationPath": integration["initializationPath"], "nextTools": []string{"galaxy_native_initialize_preview", "galaxy_native_initialize"}, "localOnly": true}, nil
	}
	var console any
	message := "Galaxy is already initialized. Continue with the requested local service without rerunning setup."
	if name == "open" {
		language := "zh-CN"
		if input.Language == "en-US" {
			language = "en-US"
		}
		value := uploadObject(uploadObject(templates["console"])[language])
		localStatus := uploadObject(value["localStatus"])
		localStatus["initializationPath"], localStatus["galaxyId"], localStatus["subjectType"], localStatus["uploadPrivacy"] = integration["initializationPath"], local["id"], local["subjectType"], status["uploadPrivacy"]
		for _, section := range uploadRows(value["sections"]) {
			for _, action := range uploadRows(uploadObject(section)["actions"]) {
				entry := uploadObject(action)
				if entry["id"] == "case" {
					entry["selectable"] = enabled["case-workspace"]
				}
			}
		}
		console = value
		title = uploadObject(value["header"])["title"]
		message = text(uploadObject(value["welcome"])["summary"])
	} else if name == "setup" {
		message = "Galaxy is already initialized. Use setup only to preview and confirm a configuration change; normal work does not rerun initialization."
	}
	return map[string]any{"command": name, "state": "ready", "route": route, "title": title, "message": message, "currentInitializationPath": integration["initializationPath"], "enabledModules": integration["modules"], "console": console, "localOnly": true}, nil
}
