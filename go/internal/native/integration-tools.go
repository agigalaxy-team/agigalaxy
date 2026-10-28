package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"sort"

	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func integrationContracts() map[string]any {
	var out map[string]any
	_ = protocol.Decode([]byte(integrationContractsJSON), &out)
	return out
}
func integrationTrim(v any) any {
	units, ok := integrationUnits(v)
	if !ok {
		return v
	}
	units = units.Trim()
	if units.HasUnpaired() {
		return units
	}
	return units.Decoded()
}
func integrationInput(name string, input map[string]any) (map[string]any, error) {
	contract := uploadObject(integrationContracts()[name])
	schema := uploadObject(contract["schema"])
	properties := uploadObject(schema["properties"])
	if schema["additionalProperties"] != false {
		kept := map[string]any{}
		for key, value := range input {
			if _, ok := properties[key]; ok {
				kept[key] = value
			}
		}
		input = kept
	}
	remoteDefaults(schema, input)
	trim := []string{}
	switch name {
	case "galaxy_case_create_escalation_draft":
		trim = []string{"title", "failureSummary"}
		for i, v := range uploadRows(input["attemptedApproaches"]) {
			uploadRows(input["attemptedApproaches"])[i] = integrationTrim(v)
		}
	case "galaxy_case_preview_disclosure":
		trim = []string{"recipient", "purpose"}
	case "galaxy_case_confirm_local_proof_draft":
		trim = []string{"verificationNote"}
	case "galaxy_integration_preview_initialization", "galaxy_integration_initialize":
		for i, v := range uploadRows(input["modules"]) {
			uploadRows(input["modules"])[i] = integrationTrim(v)
		}
	}
	for _, key := range trim {
		if value, ok := input[key]; ok {
			input[key] = integrationTrim(value)
		}
	}
	raw, e := jstext.EncodeJSON(input)
	if e != nil {
		return nil, e
	}
	parsed, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, e
	}
	input = psObject(parsed)
	if remoteChatValidate(schema, input) != nil {
		return nil, connectionFailure("local_integration_input_invalid")
	}
	return input, nil
}
func integrationRegistrationSchema(name string) map[string]any {
	schema := identityClone(uploadObject(integrationContracts()[name])["schema"])
	props := uploadObject(schema["properties"])
	for _, key := range map[string][]string{"galaxy_case_create_escalation_draft": {"title", "failureSummary"}, "galaxy_case_preview_disclosure": {"recipient", "purpose"}, "galaxy_case_confirm_local_proof_draft": {"verificationNote"}}[name] {
		delete(uploadObject(props[key]), "maxLength")
	}
	if isOne(name, "galaxy_integration_initialize", "galaxy_integration_preview_initialization") {
		delete(uploadObject(uploadObject(props["modules"])["items"]), "maxLength")
	}
	if name == "galaxy_case_create_escalation_draft" {
		delete(uploadObject(uploadObject(props["attemptedApproaches"])["items"]), "maxLength")
	}
	return schema
}
func (s *Store) integrationCall(ctx context.Context, name string, input map[string]any, scope *ChoiceScope) (any, error) {
	switch name {
	case "galaxy_integration_list_modules":
		return InitializationCatalog(), nil
	case "galaxy_integration_preview_initialization":
		var x InitializationInput
		raw, e := protocol.EncodeJS(input)
		if e != nil {
			return nil, e
		}
		if e := protocol.Decode(raw, &x); e != nil {
			return nil, e
		}
		return PreviewInitialization(x)
	case "galaxy_integration_initialize":
		selection := map[string]any{}
		for _, key := range []string{"initializationPath", "profile", "modules", "subjectType", "uploadPrivacy"} {
			if v, ok := input[key]; ok {
				selection[key] = v
			}
		}
		var x InitializationInput
		raw, e := protocol.EncodeJS(selection)
		if e != nil {
			return nil, e
		}
		if e := protocol.Decode(raw, &x); e != nil {
			return nil, e
		}
		value, e := s.Initialize(ctx, x, true, scope)
		if e != nil {
			return nil, e
		}
		result := uploadObject(uploadObject(value)["result"])
		if result == nil {
			return nil, connectionFailure("local_initialization_incomplete")
		}
		return result, nil
	case "galaxy_integration_status":
		return s.IntegrationReadStatus(ctx)
	case "galaxy_command":
		var x CommandInput
		raw, e := protocol.EncodeJS(input)
		if e != nil {
			return nil, e
		}
		if e := protocol.Decode(raw, &x); e != nil {
			return nil, e
		}
		return s.IntegrationCommand(ctx, x)
	case "galaxy_open_official_website":
		return integrationOpenWebsite(ctx)
	case "galaxy_connection_preview", "galaxy_connection_status":
		return s.IntegrationConnectionStatus(ctx)
	case "galaxy_identity_status", "galaxy_identity_describe_guid":
		snapshot, e := s.integrationSnapshot(ctx)
		if e != nil {
			return nil, e
		}
		if e = integrationModules(snapshot, "galaxy-id"); e != nil {
			return nil, e
		}
		identity := uploadObject(snapshot["identity"])
		if name == "galaxy_identity_describe_guid" {
			return map[string]any{"galaxyId": identity, "description": integrationDescribe(identity)}, nil
		}
		state := uploadObject(snapshot["state"])
		return map[string]any{"dataDir": s.Directory, "galaxyId": identity, "modules": uploadObject(state["integration"])["modules"], "counts": map[string]any{"cases": len(uploadRows(state["cases"])), "disclosurePlans": len(uploadRows(state["disclosurePlans"])), "consentGrants": len(uploadRows(state["consentGrants"])), "localProofDrafts": len(uploadRows(state["localProofDrafts"]))}}, nil
	case "galaxy_case_create_escalation_draft":
		return s.IntegrationCase(ctx, input, scope)
	case "galaxy_case_preview_disclosure":
		return s.IntegrationDisclosure(ctx, input, scope)
	case "galaxy_case_confirm_local_proof_draft":
		return s.IntegrationConfirmProof(ctx, input, scope)
	case "galaxy_consent_revoke":
		return s.IntegrationRevoke(ctx, text(input["consentGrantId"]), scope)
	case "galaxy_history_list_local_drafts":
		return s.IntegrationDrafts(ctx, int(integer(input["limit"])))
	default:
		return s.integrationMaterialCall(ctx, name, input, scope)
	}
}
func registerIntegrationTools(server *mcp.Server, tools *toolRuntime) {
	// Existing local history/archive handlers already carry their real SQLite
	// services and choices. Do not register a second handler or any cloud tool.
	existing := map[string]bool{}
	for _, name := range []string{"galaxy_local_work_list", "galaxy_local_work_get", "galaxy_local_work_pending", "galaxy_local_work_summary", "galaxy_local_work_note", "galaxy_local_work_export", "galaxy_local_work_delete", "galaxy_local_archive_settings", "galaxy_local_archive_configure", "galaxy_local_archive_list", "galaxy_local_archive_export", "galaxy_local_archive_delete", "galaxy_local_archive_cleanup"} {
		existing[name] = true
	}
	contracts := integrationContracts()
	names := []string{}
	for name := range contracts {
		if !existing[name] {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	for _, name := range names {
		contract := uploadObject(contracts[name])
		annotations := uploadObject(contract["annotations"])
		hint := &mcp.ToolAnnotations{ReadOnlyHint: annotations["readOnlyHint"] == true}
		if v, ok := annotations["openWorldHint"].(bool); ok {
			hint.OpenWorldHint = &v
		}
		if v, ok := annotations["destructiveHint"].(bool); ok {
			hint.DestructiveHint = &v
		}
		addNativeTool(server, &mcp.Tool{Name: name, Title: text(contract["title"]), Description: text(contract["description"]), InputSchema: integrationRegistrationSchema(name), Annotations: hint}, "local_integration_input_invalid", func(ctx context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			value, e := jstext.DecodeJSON(request.Params.Arguments)
			if e != nil {
				return toolError(e)
			}
			input := psObject(value)
			input, e = integrationInput(name, input)
			if e != nil {
				return toolError(e)
			}
			var scope *ChoiceScope
			if isOne(name, "galaxy_local_upload_privacy_set", "galaxy_local_settings_save", "galaxy_local_worker_identity_create", "galaxy_case_create_escalation_draft", "galaxy_case_preview_disclosure", "galaxy_case_confirm_local_proof_draft", "galaxy_consent_revoke", "galaxy_integration_initialize") {
				captured, scopeError := tools.store.ChoiceScope(ctx)
				if scopeError != nil {
					if name != "galaxy_integration_initialize" || fault.Code(scopeError) != "local_work_identity_recovery_required" {
						return toolError(scopeError)
					}
				} else {
					scope = &captured
				}
			}
			if isOne(name, "galaxy_local_upload_privacy_set", "galaxy_local_settings_save", "galaxy_local_worker_identity_create") {
				return tools.review(ctx, request, input, "本人选择当前本机资料设置或独立Worker身份；不连接服务、不上传、不启动模型。\n"+hostJSONString(input), func(selected *ChoiceScope) (any, error) {
					if selected == nil || scope == nil || *selected != *scope {
						return nil, connectionFailure("local_identity_changed")
					}
					return tools.store.integrationCall(ctx, name, input, selected)
				})
			}
			out, e := tools.store.integrationCall(ctx, name, input, scope)
			if e != nil {
				return toolError(e)
			}
			return toolResult(out)
		})
	}
}

// Literal original confirmation fields remain input contracts, not a new
// Native session/authorization grant. NewToolServer never creates Runtime.
