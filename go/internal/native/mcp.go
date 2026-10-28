package native

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"os"
	"strings"
	"sync"
	"time"
)

type choiceRecord struct {
	Owner, Hash string
	Expires     time.Time
	Running     bool
	Result      *mcp.CallToolResult
}
type toolRuntime struct {
	store   *Store
	key     []byte
	mu      sync.Mutex
	choices map[string]*choiceRecord
	browser *BrowserChoices
}
type ToolServer struct {
	*mcp.Server
	browser       *BrowserChoices
	closeServices func()
}

func (s *ToolServer) Close() {
	if s != nil && s.closeServices != nil {
		s.closeServices()
	}
	if s != nil && s.browser != nil {
		s.browser.Close()
	}
}
func (s *ToolServer) Run(ctx context.Context, transport mcp.Transport) error {
	defer s.Close()
	return s.Server.Run(ctx, transport)
}

func toolResult(v any) (*mcp.CallToolResult, error) {
	b, e := protocol.Encode(v)
	if e != nil {
		return nil, e
	}
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}, nil
}
func toolError(e error) (*mcp.CallToolResult, error) {
	r, _ := toolResult(map[string]any{"error": fault.Code(e)})
	r.IsError = true
	return r, nil
}
func objectSchema(properties map[string]any, required ...string) map[string]any {
	if required == nil {
		required = []string{}
	}
	return map[string]any{"type": "object", "properties": properties, "additionalProperties": false, "required": required}
}
func stringSchema() any { return map[string]any{"type": "string", "minLength": 1, "maxLength": 512} }
func integerSchema(min, max, def int) any {
	return map[string]any{"type": "integer", "minimum": min, "maximum": max, "default": def}
}
func NewToolServer(store *Store) (*ToolServer, error) {
	return newToolServer(store, nil)
}

func NewRuntimeToolServer(store *Store, runtime *Runtime, artifacts ...*InteractionArtifact) (*ToolServer, error) {
	if runtime == nil || runtime.store != store {
		return nil, fault.New("native_runtime_invalid", 400)
	}
	return newToolServer(store, runtime, artifacts...)
}

func newToolServer(store *Store, runtime *Runtime, artifacts ...*InteractionArtifact) (*ToolServer, error) {
	if len(artifacts) > 1 {
		return nil, fault.New("panel_artifact_required", 400)
	}
	key := make([]byte, 32)
	if _, e := rand.Read(key); e != nil {
		return nil, e
	}
	rt := &toolRuntime{store: store, key: key, choices: map[string]*choiceRecord{}, browser: NewBrowserChoices(store, nil)}
	serverName := "galaxy-native-v2"
	serverInstructions := "Development Go migration: only listed tools are implemented. An existing saved connection may be resumed by status; a new connection choice requires the person's confirmation. No implicit upload, model use, identity creation or device change. Preserve current identity and original operations; this is not the complete migrated client."
	if runtime == nil {
		serverName = "galaxy-integration-mcp"
		serverInstructions = "Galaxy Integration Pack is local-only in Founding Beta. Treat /Galaxy as a state-aware entry: initialize only on first use or after the user explicitly requests a configuration change. Start by listing initialization paths and previewing the requested plan. Do not call galaxy_integration_initialize until the user has reviewed the plan and explicitly confirmed the local module selection. No current module uploads Case content, publishes Proof, creates a remote account, or claims independent verification. Open a browser only when the user explicitly requests the configured official website and confirms the dedicated website-opening action."
	}
	s := mcp.NewServer(&mcp.Implementation{Name: serverName, Version: "0.3.0-go-development"}, &mcp.ServerOptions{Instructions: serverInstructions})
	var closeServices func()
	if runtime != nil {
		if len(runtime.config.A2A) > 0 {
			a2a, err := NewNativeA2a(runtime, runtime.config.A2A, A2aOptions{ReadEnvironment: os.LookupEnv})
			if err != nil {
				rt.browser.Close()
				return nil, err
			}
			stopA2aCore := registerNativeA2aTools(s, rt, a2a)
			var purposeOptions WorkerToolOptions
			if len(artifacts) == 1 && artifacts[0].valid() {
				purposeOptions.Meta = InteractionToolMeta(artifacts[0].URI, false)
				purposeOptions.ComponentOnly = nativeCompactUIAdvertised
			}
			stopA2aWork := registerNativeA2aWorkTools(s, rt, a2a, purposeOptions)
			closeServices = func() { stopA2aWork(); stopA2aCore() }
		}
		if len(runtime.config.WorkerPacks) > 0 {
			worker, err := NewNativeWorkerHost(runtime, runtime.config.WorkerPacks, runtime.config.A2A, A2aOptions{ReadEnvironment: os.LookupEnv})
			if err != nil {
				if closeServices != nil {
					closeServices()
				}
				rt.browser.Close()
				return nil, err
			}
			var options WorkerToolOptions
			if len(artifacts) == 1 && artifacts[0].valid() {
				options.Meta = InteractionToolMeta(artifacts[0].URI, false)
				options.ComponentOnly = nativeCompactUIAdvertised
			}
			stopWorker := registerNativeWorkerTools(s, rt, worker, options)
			stopA2A := closeServices
			closeServices = func() {
				stopWorker()
				if stopA2A != nil {
					stopA2A()
				}
			}
		}
		registerRuntimeTools(s, rt, runtime)
		registerUploadTools(s, rt, runtime)
		registerNativeUploadPreviewTools(s, rt, runtime)
		registerIdentityControlTools(s, rt, runtime)
		registerCommandTools(s, rt, runtime)
		registerRemoteChatTools(s, rt, runtime)
		registerRemoteCommunityTools(s, rt, runtime)
		registerNavigationTools(s, rt, runtime)
		registerNativeReferenceTools(s, rt, runtime)
		registerNativeAuthorizationTool(s, rt, runtime)
		registerRemoteTaskTools(s, rt, runtime)
		registerRemoteFactsTools(s, rt, runtime)
		registerRemoteProjectTools(s, rt, runtime)
		registerRemoteSummaryTools(s, rt, runtime)
		registerRemoteInboxTools(s, rt, runtime)
		registerRemoteCommentTools(s, rt, runtime)
		registerRemoteHubTools(s, rt, runtime)
		registerRemoteIdentityGroupTools(s, rt, runtime)
		registerRemoteMaterialTools(s, rt, runtime)
		registerRemoteReputationTools(s, rt, runtime)
		registerRemoteCITools(s, rt, runtime)
		registerRemoteContactsTools(s, rt, runtime)
		registerRemoteInformationTools(s, rt, runtime)
		registerRemoteWatchTools(s, rt, runtime)
		registerExtendedRemoteTools(s, rt, runtime)
		registerNativeBookmarkTool(s, rt, runtime)
		registerNativeWorkSelectionTools(s, rt, runtime)
		registerWorkContinuationTools(s, rt, runtime)
		stopGroups := registerNativeIdentityGroupTools(s, rt, runtime)
		stopSummaries := registerPersonalSummaryTools(s, rt, runtime)
		stopCapsuleWork := registerNativeCapsuleWorkTools(s, rt, runtime)
		stopTrust := registerNativeTrustTools(s, rt, runtime)
		stopContacts := registerNativeContactWorkTools(s, rt, runtime)
		stopWatch := registerNativeWatchTools(s, rt, runtime)
		stopHelp := registerNativeHelpTools(s, rt, runtime)
		stopWebHandoff := registerNativeWebHandoffTools(s, rt, runtime)
		stopNotifications, notificationError := registerNativeHostNotificationTools(s, rt, runtime)
		stopPrevious := closeServices
		closeServices = func() {
			if stopNotifications != nil {
				stopNotifications()
			}
			stopWatch()
			stopWebHandoff()
			stopHelp()
			stopContacts()
			stopTrust()
			stopCapsuleWork()
			stopSummaries()
			stopGroups()
			if stopPrevious != nil {
				stopPrevious()
			}
		}
		if notificationError != nil {
			closeServices()
			rt.browser.Close()
			return nil, notificationError
		}
		if len(artifacts) == 1 {
			reviewer := func(ctx context.Context, req *mcp.CallToolRequest, name string, input any, message string, run func(*ChoiceScope) (any, error)) (*mcp.CallToolResult, error) {
				copyRequest := *req
				copyParams := *req.Params
				copyParams.Name = name
				copyRequest.Params = &copyParams
				return rt.review(ctx, &copyRequest, input, message, run)
			}
			e := RegisterInteractionApps(s, runtime, artifacts[0], reviewer, InteractionAppOperations{SaveSettings: func(ctx context.Context, raw json.RawMessage, scope *ChoiceScope) (any, error) {
				var input NativeLocalSettingsInput
				if e := protocol.Decode(raw, &input); e != nil {
					return nil, e
				}
				return runtime.SaveLocalSettingsReviewed(ctx, input, scope)
			}})
			if e != nil {
				if closeServices != nil {
					closeServices()
				}
				rt.browser.Close()
				return nil, e
			}
			stopPanel := registerNativePanelTools(s, rt, runtime, runtime.nativeHelp, runtime.navigation, artifacts[0])
			stopShared := closeServices
			closeServices = func() {
				stopPanel()
				if stopShared != nil {
					stopShared()
				}
			}
		}
	}
	registerHistoryMaterial(s, store)
	registerInitializationTools(s, rt)
	registerLocalMaterialTools(s, rt)
	listProps := map[string]any{"galaxyId": stringSchema(), "host": stringSchema(), "limit": integerSchema(1, 100, 20), "after": map[string]any{"type": "string", "pattern": "^[0-9]+$"}}
	addNativeTool(s, &mcp.Tool{Name: "galaxy_local_work_list", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}, Description: "Read current identity's actual local work history without creating an identity, connecting or running a model.", InputSchema: objectSchema(listProps)}, "local_work_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x struct {
			GalaxyID string `json:"galaxyId"`
			Host     string `json:"host"`
			Limit    *int   `json:"limit"`
			After    string `json:"after"`
		}
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(e)
		}
		q := WorkQuery{GalaxyID: x.GalaxyID, Host: x.Host, After: x.After, Limit: 20}
		if x.Limit != nil {
			q.Limit = *x.Limit
			if q.Limit == 0 {
				return toolError(fault.New("local_work_input_invalid", 400))
			}
		}
		v, e := store.WorkList(ctx, q)
		if e != nil {
			return toolError(e)
		}
		return toolResult(v)
	})
	getProps := map[string]any{"galaxyId": stringSchema(), "workId": stringSchema(), "host": stringSchema(), "sessionId": stringSchema(), "afterSequence": map[string]any{"type": "integer", "minimum": 0, "default": 0}, "limit": integerSchema(1, 200, 100)}
	addNativeTool(s, &mcp.Tool{Name: "galaxy_local_work_get", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}, Description: "Read actually retained observations and own-model summaries for the selected current-identity work.", InputSchema: objectSchema(getProps)}, "local_work_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var q WorkQuery
		if e := protocol.Decode(req.Params.Arguments, &q); e != nil {
			return toolError(e)
		}
		var raw map[string]json.RawMessage
		_ = json.Unmarshal(req.Params.Arguments, &raw)
		if _, ok := raw["after"]; ok {
			return toolError(fault.New("local_work_input_invalid", 400))
		}
		if b, ok := raw["limit"]; ok && string(b) == "0" {
			return toolError(fault.New("local_work_input_invalid", 400))
		}
		v, e := store.WorkGet(ctx, q)
		if e != nil {
			return toolError(e)
		}
		return toolResult(v)
	})
	addNativeTool(s, &mcp.Tool{Name: "galaxy_local_archive_settings", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}, Description: "Read current identity's explicit local original-message capture settings. No upload or implicit selection.", InputSchema: objectSchema(map[string]any{})}, "local_archive_input_invalid", func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		var x struct{}
		if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
			return toolError(e)
		}
		v, e := store.ArchiveSettings(ctx)
		if e != nil {
			return toolError(e)
		}
		return toolResult(v)
	})
	props := map[string]any{"galaxyId": stringSchema(), "enabled": map[string]any{"type": "boolean"}, "sessions": map[string]any{"type": "array", "maxItems": 500, "items": objectSchema(map[string]any{"host": stringSchema(), "sessionId": stringSchema()}, "host", "sessionId")}, "autoCleanAfterDays": map[string]any{"type": []string{"integer", "null"}, "minimum": 1, "maximum": 36500, "default": nil}}
	addNativeTool(s, &mcp.Tool{Name: "galaxy_local_archive_configure", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: false}, Description: "Choose exact existing host/session scopes for private local original capture and optional cleanup. Requires actual person input; no upload.", InputSchema: objectSchema(props, "enabled", "sessions")}, "local_archive_input_invalid", rt.configure)
	if runtime == nil {
		registerIntegrationTools(s, rt)
	}
	return &ToolServer{Server: s, browser: rt.browser, closeServices: closeServices}, nil
}
func (r *toolRuntime) token(nonce string) string {
	m := hmac.New(sha256.New, r.key)
	m.Write([]byte(nonce))
	return nonce + "." + base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}
func (r *toolRuntime) verify(token string) (string, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return "", false
	}
	expected := r.token(parts[0])
	return parts[0], hmac.Equal([]byte(token), []byte(expected))
}
func (r *toolRuntime) configure(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
	var x ArchiveInput
	if e := protocol.Decode(req.Params.Arguments, &x); e != nil {
		return toolError(e)
	}
	if e := ValidateArchive(x); e != nil {
		return toolError(e)
	}
	owner, e := r.store.Owner(ctx)
	if e != nil {
		return toolError(e)
	}
	if owner == "" {
		return toolError(fault.New("local_identity_required", 409))
	}
	if x.GalaxyID != "" && x.GalaxyID != owner {
		return toolError(fault.New("local_identity_mismatch", 409))
	}
	x.GalaxyID = owner
	message, e := r.store.archiveChoiceMessage(ctx, x)
	if e != nil {
		return toolError(e)
	}
	return r.review(ctx, req, x, message, func(scope *ChoiceScope) (any, error) {
		x.GalaxyID = scope.Owner
		return r.store.configureArchive(ctx, x, scope)
	})
}
