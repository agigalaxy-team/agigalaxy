package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/trustpackages"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"sort"
)

func nativeTrustInput(name string, input any) (map[string]any, error) {
	// Preserve original JSON strings (including unpaired UTF-16) and apply the
	// claim trim before the schema's bounds, just as its original Zod parser.
	value, e := trustJSON(input)
	if e != nil || value == nil {
		return nil, remoteFactsInvalid()
	}
	if name == "galaxy_trust_native_prepare" && value["action"] == "package" {
		for _, v := range trustArray(value["claims"]) {
			c := psObject(v)
			switch s := c["text"].(type) {
			case string:
				c["text"] = jstext.From(s).Trim()
			case jstext.String:
				c["text"] = s.Trim()
			}
		}
	}
	value, e = remoteReputationInput(remoteSelectedContracts(nativeTrustContractsJSON), name, value)
	if e != nil {
		return nil, e
	}
	if name == "galaxy_trust_native_prepare" && (value["action"] == "grant" || value["action"] == "revoke") {
		kind := "preview"
		if value["action"] == "revoke" {
			kind = "revoke-preview"
		}
		if _, e = trustpackages.Parse(kind, psObject(value["input"])); e != nil {
			return nil, remoteFactsInvalid()
		}
	}
	return value, nil
}
func nativeTrustError(e error) (*mcp.CallToolResult, error) {
	result, encoding := toolResult(map[string]any{"error": runtimeErrorCode(e), "reason": e.Error(), "originalOperationRetained": true})
	if result != nil {
		result.IsError = true
	}
	return result, encoding
}
func trustOptionalString(value any) *string {
	if value == nil {
		return nil
	}
	s := text(value)
	return &s
}
func nativeTrustVCPin(input map[string]any) (trustpackages.VCVerifyOptions, error) {
	selected := psObject(input["issuerPin"])
	issuer, e := trustpackages.SubjectURI(text(selected["issuer"]))
	if e != nil {
		return trustpackages.VCVerifyOptions{}, e
	}
	pin := trustpackages.VCIssuerPin{PublicKeyPEM: text(selected["publicKeyPem"]), Revoked: selected["revoked"] == true}
	if v, ok := selected["notBefore"]; ok {
		n := psInt(v)
		pin.NotBefore = &n
	}
	if v, ok := selected["notAfter"]; ok {
		n := psInt(v)
		pin.NotAfter = &n
	}
	return trustpackages.VCVerifyOptions{TrustedIssuers: map[string]map[string]trustpackages.VCIssuerPin{issuer: {text(selected["kid"]): pin}}, ExpectedIssuer: &issuer, ExpectedSubject: trustOptionalString(input["expectedSubject"]), Audience: trustOptionalString(input["audience"])}, nil
}

// registerNativeTrustTools keeps the original nine tool names and review
// surfaces. The returned close clears only unsigned in-memory previews; signed
// unknown operations remain in the existing private local journal.
func registerNativeTrustTools(server *mcp.Server, tools *toolRuntime, runtime *Runtime) func() {
	host := NewNativeTrust(runtime)
	contracts := remoteSelectedContracts(nativeTrustContractsJSON)
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		contract := psObject(contracts[name])
		write := contract["write"] == true
		addNativeTool(server, &mcp.Tool{Name: name, InputSchema: contract["schema"], Description: text(contract["description"]), Annotations: &mcp.ToolAnnotations{ReadOnlyHint: !write}}, "invalid_trust_input", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			decoded, e := jstext.DecodeJSON(req.Params.Arguments)
			if e != nil {
				return nativeTrustError(e)
			}
			input, e := nativeTrustInput(name, decoded)
			if e != nil {
				return nativeTrustError(e)
			}
			var out any
			switch name {
			case "galaxy_trust_native_refresh_identity":
				out, e = host.refresh(ctx)
			case "galaxy_trust_native_prepare":
				out, e = host.Prepare(ctx, input)
			case "galaxy_trust_native_execute":
				id := text(input["operationId"])
				p, err := host.preview(ctx, id)
				if err != nil {
					return nativeTrustError(err)
				}
				host.mu.Lock()
				state, receipt := p.state, p.receipt
				host.mu.Unlock()
				if state != "prepared" {
					return toolResult(map[string]any{"operationId": id, "state": state, "receipt": receipt, "retryWith": "galaxy_trust_native_recover"})
				}
				shown, err := trustJSON(p.value)
				if err != nil {
					return nativeTrustError(err)
				}
				shown["state"] = "ready"
				review := map[string]any{"operationId": id, "action": p.action, "preview": shown}
				return tools.review(ctx, req, review, text(contract["description"]), func(scope *ChoiceScope) (any, error) { return host.ExecuteReviewed(ctx, id, scope) })
			case "galaxy_trust_native_cancel_preview":
				out, e = host.Cancel(ctx, text(input["operationId"]))
			case "galaxy_trust_native_import":
				out, e = trustpackages.Verify(input["package"], trustpackages.VerifyOptions{Now: host.now()})
			case "galaxy_trust_native_import_vc":
				lease, err := host.capture(ctx)
				if err != nil {
					return nativeTrustError(err)
				}
				bundle := psObject(input["bundle"])
				manifest, err := trustParseText(psObject(bundle["package"])["manifestJson"])
				if err != nil {
					return nativeTrustError(err)
				}
				shown := map[string]any{"packageId": manifest["packageId"], "credentialHash": identity.Digest([]byte(text(bundle["credential"]))), "issuerPin": input["issuerPin"], "expectedSubject": input["expectedSubject"], "audience": input["audience"]}
				return tools.review(ctx, req, shown, text(contract["description"]), func(scope *ChoiceScope) (any, error) {
					if scope == nil || *scope != lease.scope {
						return nil, connectionFailure("trust_identity_changed")
					}
					if e := lease.check(ctx); e != nil {
						return nil, e
					}
					options, e := nativeTrustVCPin(input)
					if e != nil {
						return nil, e
					}
					options.Now = host.now()
					result, e := trustpackages.VerifyVC(bundle, options)
					if check := lease.check(ctx); check != nil {
						return nil, check
					}
					return result, e
				})
			case "galaxy_trust_native_check_online":
				container := psObject(input["package"])
				manifest, err := trustParseText(container["manifestJson"])
				if err != nil {
					return nativeTrustError(err)
				}
				return tools.review(ctx, req, map[string]any{"packageId": manifest["packageId"], "selectedEndpoint": input["selectedEndpoint"]}, text(contract["description"]), func(scope *ChoiceScope) (any, error) {
					return host.CheckOnline(ctx, container, text(input["selectedEndpoint"]), scope)
				})
			case "galaxy_trust_native_permissions":
				scope, err := runtime.store.ChoiceScope(ctx)
				if err != nil {
					return nativeTrustError(err)
				}
				out, e = runtime.Call(ctx, "/v2/trust-package/permissions/query", input, ConnectionCallOptions{ExpectedScope: &scope})
			case "galaxy_trust_native_recover":
				out, e = host.Recover(ctx, input)
			default:
				e = remoteFactsInvalid()
			}
			if e != nil {
				return nativeTrustError(e)
			}
			return toolResult(out)
		})
	}
	return host.Close
}
