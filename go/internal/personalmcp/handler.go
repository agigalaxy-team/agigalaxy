package personalmcp

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/google/jsonschema-go/jsonschema"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// catalog.json is the maintained personal MCP wire contract. It has no runtime
// dependency on the retired Node registration handler or its one-time exporter.
//go:embed catalog.json
var catalogJSON []byte

type Consumer func(context.Context, deviceauth.Actor, Object, *string) (any, error)
type definition struct {
	Name        string               `json:"name"`
	Description string               `json:"description"`
	InputSchema json.RawMessage      `json:"inputSchema"`
	Annotations *mcp.ToolAnnotations `json:"annotations"`
	Scope       any                  `json:"scope"`
	resolved    *jsonschema.Resolved
	consume     Consumer
}
type Handler struct {
	configurationHash string
	MetadataPath      string
	Resource          string
	Next              http.Handler
	services          Services
	authority         *deviceauth.OAuthResourceAccess
	metadata          Object
	host              string
	tools             []definition
}

func (h *Handler) ConfigurationHash() string { return h.configurationHash }

// NewHandler accepts the already constructed, source-bound OAuth authority.
// Consumers are direct Go domain calls. A tool is advertised only when its real
// consumer is installed; missing domains cannot appear as usable capabilities.
func NewHandler(services Services, authority *deviceauth.OAuthResourceAccess, verifier *deviceauth.OAuthIntrospection) (*Handler, error) {
	if services.Devices == nil || authority == nil || verifier == nil {
		return nil, configurationError()
	}
	resource := services.Devices.Endpoint + "/mcp/personal"
	u, e := url.Parse(resource)
	if e != nil || u.Host == "" || verifier.Resource() != resource {
		return nil, configurationError()
	}
	h := &Handler{services: services, authority: authority, Resource: resource, MetadataPath: "/.well-known/oauth-protected-resource/mcp/personal", host: u.Host}
	issuer := verifier.Metadata()["issuer"]
	h.metadata = Object{"resource": resource, "authorization_servers": []any{issuer}, "scopes_supported": []string{"galaxy:binding"}, "resource_name": "Galaxy Personal"}
	var catalog []definition
	if json.Unmarshal(catalogJSON, &catalog) != nil {
		return nil, configurationError()
	}
	consumers := services.consumers()
	for _, d := range catalog {
		consumer := consumers[d.Name]
		if consumer == nil {
			continue
		}
		var schema jsonschema.Schema
		if json.Unmarshal(d.InputSchema, &schema) != nil {
			return nil, configurationError()
		}
		resolved, e := schema.Resolve(nil)
		if e != nil {
			return nil, e
		}
		d.resolved = resolved
		d.consume = consumer
		h.tools = append(h.tools, d)
	}
	return h, nil
}
func (h *Handler) Metadata() Object {
	raw, _ := json.Marshal(h.metadata)
	var out Object
	_ = json.Unmarshal(raw, &out)
	return out
}
func scope(d definition, input Object) string {
	if s, ok := d.Scope.(string); ok {
		return s
	}
	m, _ := d.Scope.(map[string]any)
	kind, _ := input["type"].(string)
	if search, ok := input["search"].(map[string]any); ok {
		kind, _ = search["type"].(string)
	}
	s, _ := m[kind].(string)
	return s
}
func result(text string, isError bool) *mcp.CallToolResult {
	return &mcp.CallToolResult{IsError: isError, Content: []mcp.Content{&mcp.TextContent{Text: text}}}
}
func operationError(e error) *mcp.CallToolResult {
	var service *fault.Error
	if !errors.As(e, &service) {
		return result("operation_failed", true)
	}
	if details := publicwrites.Details(e); len(details) > 0 {
		details["error"] = service.Code
		raw, _ := protocol.EncodeJS(details)
		return result(string(raw), true)
	}
	return result(service.Code, true)
}
func parseArguments(d definition, raw json.RawMessage) (Object, error) {
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	var input Object
	if json.Unmarshal(raw, &input) != nil || input == nil {
		return nil, fault.New("invalid_request", 400)
	}
	if e := d.resolved.ApplyDefaults(&input); e != nil {
		return nil, e
	}
	if e := d.resolved.Validate(input); e != nil {
		return nil, e
	}
	value, e := jstext.DecodeJSON(raw)
	if e != nil {
		return nil, e
	}
	actual, ok := value.(map[string]any)
	if !ok {
		return nil, fault.New("invalid_request", 400)
	}
	mergeDefaults(actual, input)
	return actual, nil
}
func mergeDefaults(actual, defaults Object) {
	for k, v := range defaults {
		existing, ok := actual[k]
		if !ok {
			actual[k] = v
			continue
		}
		a, aok := existing.(map[string]any)
		d, dok := v.(map[string]any)
		if aok && dok {
			mergeDefaults(a, d)
		}
	}
}
func (h *Handler) server(authentication deviceauth.OAuthAuthentication, requestID *string) *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "galaxy-personal", Version: "0.1.0"}, nil)
	for _, d := range h.tools {
		var schema any
		_ = json.Unmarshal(d.InputSchema, &schema)
		s.AddTool(&mcp.Tool{Name: d.Name, Description: d.Description, InputSchema: schema, Annotations: d.Annotations}, func(ctx context.Context, r *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			input, e := parseArguments(d, r.Params.Arguments)
			if e != nil {
				return result("Invalid tool arguments: "+e.Error(), true), nil
			}
			required := scope(d, input)
			if required == "" || !included(authentication.AuthInfo.Scopes, "galaxy:"+required) {
				return result("insufficient_scope", true), nil
			}
			v, e := d.consume(ctx, authentication.Actor, input, requestID)
			if e != nil {
				return operationError(e), nil
			}
			raw, e := protocol.EncodeJS(v)
			if e != nil {
				return operationError(e), nil
			}
			return result(string(raw), false), nil
		})
	}
	return s
}
func (h *Handler) reject(w http.ResponseWriter, status int, code string, scopes []string, challenge bool) {
	w.Header().Set("Content-Type", "application/json")
	if challenge {
		value := `Bearer resource_metadata="` + h.services.Devices.Endpoint + h.MetadataPath + `"`
		if code != "" {
			value += `, error="` + code + `"`
		}
		if len(scopes) > 0 {
			value += `, scope="` + strings.Join(scopes, " ") + `"`
		}
		w.Header().Set("WWW-Authenticate", value)
	}
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Object{"error": code})
}
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == h.MetadataPath {
		if r.Method != "GET" {
			h.reject(w, 405, "method_not_allowed", nil, false)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(h.Metadata())
		return
	}
	if r.URL.Path != "/mcp/personal" {
		if h.Next != nil {
			h.Next.ServeHTTP(w, r)
		} else {
			http.NotFound(w, r)
		}
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	if r.Host != h.host {
		h.reject(w, 403, "invalid_host", nil, false)
		return
	}
	values := r.Header.Values("Authorization")
	var bearer []string
	if len(values) == 1 {
		bearer = strings.Split(values[0], " ")
	}
	if len(bearer) < 2 || !strings.EqualFold(bearer[0], "Bearer") || bearer[1] == "" {
		h.reject(w, 401, "invalid_token", []string{"galaxy:binding"}, true)
		return
	}
	requestID := uuid.NewString()
	authentication, e := h.authority.Authenticate(r.Context(), bearer[1], &requestID)
	if e != nil {
		h.reject(w, fault.Status(e), fault.Code(e), []string{"galaxy:binding"}, fault.Code(e) == "invalid_token")
		return
	}
	if !included(authentication.AuthInfo.Scopes, "galaxy:binding") {
		h.reject(w, 403, "insufficient_scope", []string{"galaxy:binding"}, true)
		return
	}
	if r.Method == "POST" {
		if r.Header.Get("Content-Type") != "application/json" || r.Header.Get("Content-Encoding") != "" {
			h.reject(w, 415, "unsupported_media_type", nil, false)
			return
		}
		raw, e := io.ReadAll(io.LimitReader(r.Body, 32769))
		if e != nil || len(raw) > 32768 {
			h.reject(w, 413, "request_too_large", nil, false)
			return
		}
		var body any
		if !utf8.Valid(raw) || json.Unmarshal(raw, &body) != nil {
			h.reject(w, 400, "invalid_json", nil, false)
			return
		}
		if object, ok := body.(map[string]any); !ok || object == nil {
			h.reject(w, 400, "invalid_request", nil, false)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var envelope struct {
			Method string `json:"method"`
			Params struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			} `json:"params"`
		}
		if json.Unmarshal(raw, &envelope) == nil && envelope.Method == "tools/call" {
			for _, d := range h.tools {
				if d.Name != envelope.Params.Name {
					continue
				}
				input, e := parseArguments(d, envelope.Params.Arguments)
				if e == nil {
					required := scope(d, input)
					if required != "" && !included(authentication.AuthInfo.Scopes, "galaxy:"+required) {
						h.reject(w, 403, "insufficient_scope", []string{"galaxy:binding", "galaxy:" + required}, true)
						return
					}
				}
				break
			}
		}
	}
	transport := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return h.server(authentication, &requestID) }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, MaxRequestBodyBytes: 32768, PropagateRequestCancellation: true, DisableLocalhostProtection: true})
	transport.ServeHTTP(w, r)
}

// MissingConsumers is construction metadata for the root assembler, not a
// runtime fallback. Tools lacking a current owning implementation stay absent.
func (h *Handler) MissingConsumers() []string {
	var catalog []definition
	_ = json.Unmarshal(catalogJSON, &catalog)
	installed := map[string]bool{}
	for _, d := range h.tools {
		installed[d.Name] = true
	}
	out := []string{}
	for _, d := range catalog {
		if !installed[d.Name] {
			out = append(out, d.Name)
		}
	}
	return out
}
