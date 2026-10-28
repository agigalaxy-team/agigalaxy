package native

import (
	"context"
	"strings"
)

func integrationReferences(value any) any {
	switch v := value.(type) {
	case string:
		return strings.NewReplacer("galaxy_native_initialize_preview", "galaxy_integration_preview_initialization", "galaxy_native_initialize", "galaxy_integration_initialize").Replace(v)
	case map[string]any:
		for k, x := range v {
			v[k] = integrationReferences(x)
		}
	case []any:
		for i, x := range v {
			v[i] = integrationReferences(x)
		}
	case []string:
		for i, x := range v {
			v[i] = text(integrationReferences(x))
		}
	}
	return value
}
func (s *Store) IntegrationCommand(ctx context.Context, input CommandInput) (any, error) {
	name := strings.ToLower(uploadTrim(input.Command))
	if name == "" {
		name = "open"
	}
	templates := commandTemplates()
	definition := uploadObject(uploadObject(templates["commands"])[name])
	if definition == nil {
		return nil, connectionFailure("native_command_unknown")
	}
	snapshot, e := s.integrationSnapshot(ctx)
	if e != nil {
		return nil, e
	}
	status := integrationStatus(snapshot)
	route, title := definition["route"], definition["title"]
	paths := InitializationCatalog()["initializationPaths"]
	if status["recoveryRequired"] == true {
		return map[string]any{"command": name, "route": "galaxy-local-recovery", "state": "recovery-required", "title": "Local Galaxy recovery required", "message": "A local initialization or reset was interrupted. Preserve the local files and explicitly resume initialization or reset after reviewing the pending operation. This read performs no recovery.", "recoveryRequired": true, "nextTools": []string{}, "localOnly": true}, nil
	}
	if name == "connect" {
		contract, e := s.IntegrationConnectionStatus(ctx)
		if e != nil {
			return nil, e
		}
		return map[string]any{"command": name, "route": route, "state": contract["state"], "title": title, "connectionContract": contract, "nextTools": []string{"galaxy_connection_preview", "galaxy_connection_status"}, "localOnly": true}, nil
	}
	if name == "help" {
		return map[string]any{"command": name, "state": "ready", "route": route, "title": title, "message": "Choose a Galaxy command. Commands do not create a Galaxy ID unless the final initialization confirmation is completed.", "commands": templates["help"], "localOnly": true}, nil
	}
	if name == "language" {
		return map[string]any{"command": name, "state": "language-selection", "route": route, "title": title, "message": "Choose the display language for this Galaxy interaction. This choice is not stored in your Galaxy ID or local initialization state.", "initializationContract": CommandInitialization(CommandInput{})["initializationContract"], "localOnly": true}, nil
	}
	if name == "website" {
		return map[string]any{"command": name, "state": "website-entry", "route": route, "title": title, "message": "On Windows, the Galaxy website can be opened only after you explicitly confirm the configured official HTTPS address. No URL is inferred or opened automatically.", "nextTools": []string{"galaxy_open_official_website"}, "localOnly": true}, nil
	}
	if name == "privacy" {
		privacy, e := s.integrationMaterialCall(ctx, "galaxy_local_upload_privacy_get", map[string]any{}, nil)
		if e != nil {
			return nil, e
		}
		return map[string]any{"command": name, "route": route, "state": "ready", "title": title, "privacy": privacy, "nextTools": []string{"galaxy_local_upload_privacy_get", "galaxy_local_upload_privacy_set"}, "localOnly": true}, nil
	}
	if name == "worker" {
		return map[string]any{"command": name, "route": "galaxy-worker-identity", "state": "identity-setup-available", "title": "Separate Worker identity", "message": "Agent subjects use an isolated Worker directory. Creating that local identity preserves the normal client ID/history and starts no Worker, model, connection or upload.", "runtimeStarted": false, "nextTools": []string{"galaxy_local_worker_identity_create"}, "localOnly": true}, nil
	}
	if (name == "history" || name == "work") && snapshot["identity"] != nil {
		history, e := s.WorkList(ctx, WorkQuery{})
		if e != nil {
			return nil, e
		}
		return map[string]any{"command": name, "route": route, "state": "ready", "title": title, "history": history, "nextTools": []string{"galaxy_local_work_list", "galaxy_local_work_get", "galaxy_local_work_pending", "galaxy_local_work_summary", "galaxy_local_work_note"}, "localOnly": true}, nil
	}
	if status["initialized"] != true {
		if name == "status" {
			message := "Galaxy is not initialized on this device. No Galaxy ID, remote account, sync, Worker, Hub, or uploaded data exists."
			if snapshot["identity"] != nil {
				message = "A local Galaxy ID already exists. Integration modules are not initialized; this read creates no identity, connection or upload."
			}
			return map[string]any{"command": name, "state": "not-initialized", "route": route, "title": title, "message": message, "initializationPaths": paths, "nextTools": []string{"galaxy_command", "galaxy_integration_preview_initialization"}, "localOnly": true}, nil
		}
		out := map[string]any{"command": name, "state": "needs-initialization", "route": "galaxy-initialization", "title": "Set up Galaxy once", "message": "Galaxy has not been initialized on this device. Choose an initialization path, preview its local effects, then confirm once.", "initializationPaths": paths, "nextTools": []string{"galaxy_integration_preview_initialization", "galaxy_integration_initialize"}, "localOnly": true}
		for k, v := range CommandInitialization(input) {
			out[k] = integrationReferences(v)
		}
		return out, nil
	}
	integration := uploadObject(status["integration"])
	enabled := map[string]bool{}
	for _, v := range uploadRows(integration["modules"]) {
		enabled[text(uploadObject(v)["id"])] = true
	}
	future := text(definition["futurePath"])
	if future != "" {
		for _, v := range uploadRows(paths) {
			path := uploadObject(v)
			if path["id"] == future {
				return map[string]any{"command": name, "state": "planned-service", "route": "galaxy-configuration-change", "title": path["title"], "message": text(path["title"]) + " is a future initialization path. The current local Galaxy remains active; no Worker or Hub runtime has been created.", "currentInitializationPath": integration["initializationPath"], "requestedInitializationPath": path, "nextTools": []string{"galaxy_integration_preview_initialization"}, "localOnly": true}, nil
			}
		}
	}
	missing := []string{}
	for _, id := range mustUploadStrings(definition["requires"]) {
		if !enabled[id] {
			missing = append(missing, id)
		}
	}
	if len(missing) > 0 {
		return map[string]any{"command": name, "state": "needs-configuration-change", "route": "galaxy-configuration-change", "title": title, "message": "This local Galaxy is initialized, but the requested service is not enabled. Preview a configuration change before enabling it.", "missingModules": missing, "currentInitializationPath": integration["initializationPath"], "nextTools": []string{"galaxy_integration_preview_initialization", "galaxy_integration_initialize"}, "localOnly": true}, nil
	}
	var console any
	message := "Galaxy is already initialized. Continue with the requested local service without rerunning setup."
	if name == "open" {
		language := "zh-CN"
		if input.Language == "en-US" {
			language = "en-US"
		}
		value := uploadObject(uploadObject(templates["console"])[language])
		local := uploadObject(snapshot["identity"])
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
		console = integrationReferences(value)
		title = uploadObject(value["header"])["title"]
		message = text(uploadObject(value["welcome"])["summary"])
	} else if name == "setup" {
		message = "Galaxy is already initialized. Use setup only to preview and confirm a configuration change; normal work does not rerun initialization."
	}
	return map[string]any{"command": name, "state": "ready", "route": route, "title": title, "message": message, "currentInitializationPath": integration["initializationPath"], "enabledModules": integration["modules"], "console": console, "localOnly": true}, nil
}
