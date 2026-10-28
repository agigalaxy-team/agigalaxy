package native

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
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
	return map[string]any{"type": "object", "properties": properties, "additionalProperties": false, "required": required}
}
func stringSchema() any { return map[string]any{"type": "string", "minLength": 1, "maxLength": 512} }
func integerSchema(min, max, def int) any {
	return map[string]any{"type": "integer", "minimum": min, "maximum": max, "default": def}
}
func NewToolServer(store *Store) (*mcp.Server, error) {
	key := make([]byte, 32)
	if _, e := rand.Read(key); e != nil {
		return nil, e
	}
	rt := &toolRuntime{store: store, key: key, choices: map[string]*choiceRecord{}}
	s := mcp.NewServer(&mcp.Implementation{Name: "galaxy-native-v2", Version: "0.3.0-go-development"}, &mcp.ServerOptions{Instructions: "Development Go migration: only the listed local tools are migrated. No network connection, upload, model, device change or full-client readiness is implied. Preserve current identity and original operations."})
	listProps := map[string]any{"galaxyId": stringSchema(), "host": stringSchema(), "limit": integerSchema(1, 100, 20), "after": map[string]any{"type": "string", "pattern": "^[0-9]+$"}}
	s.AddTool(&mcp.Tool{Name: "galaxy_local_work_list", Description: "Read current identity's actual local work history without creating an identity, connecting or running a model.", InputSchema: objectSchema(listProps)}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
	s.AddTool(&mcp.Tool{Name: "galaxy_local_work_get", Description: "Read actually retained observations and own-model summaries for the selected current-identity work.", InputSchema: objectSchema(getProps)}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
	s.AddTool(&mcp.Tool{Name: "galaxy_local_archive_settings", Description: "Read current identity's explicit local original-message capture settings. No upload or implicit selection.", InputSchema: objectSchema(map[string]any{})}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
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
	s.AddTool(&mcp.Tool{Name: "galaxy_local_archive_configure", Description: "Choose exact existing host/session scopes for private local original capture and optional cleanup. Requires actual person input; no upload.", InputSchema: objectSchema(props, "enabled", "sessions")}, rt.configure)
	return s, nil
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
	scope, e := r.store.ChoiceScope(ctx)
	if e != nil {
		return toolError(e)
	}
	owner := scope.Owner
	if owner == "" {
		return toolError(fault.New("local_identity_required", 409))
	}
	if x.GalaxyID != "" && x.GalaxyID != owner {
		return toolError(fault.New("local_identity_mismatch", 409))
	}
	x.GalaxyID = owner
	canonical, e := identity.Canonical(struct {
		Input ArchiveInput
		Scope ChoiceScope
	}{x, scope})
	if e != nil {
		return toolError(e)
	}
	hash := identity.Digest(canonical)
	schema := objectSchema(map[string]any{"confirm": map[string]any{"type": "boolean", "title": "允许这里显示的内容与范围"}}, "confirm")
	review, _ := protocol.Encode(x)
	message := "银河：设置本机会话原件范围（不上传）。\n" + string(review)
	if req.Session.InitializeParams().ProtocolVersion != "2026-07-28" {
		caps := req.Session.InitializeParams().Capabilities
		if caps == nil || caps.Elicitation == nil {
			return toolError(fault.New("native_choice_browser_not_migrated", 503))
		}
		answer, e := req.Session.Elicit(ctx, &mcp.ElicitParams{Mode: "form", Message: message, RequestedSchema: schema})
		if e != nil {
			return toolError(fault.New("native_choice_unavailable", 503))
		}
		if answer.Action != "accept" || answer.Content["confirm"] != true {
			return toolResult(map[string]any{"state": "declined", "sideEffect": false})
		}
		v, e := r.store.configureArchive(ctx, x, &scope)
		if e != nil {
			return toolError(e)
		}
		return toolResult(v)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for nonce, v := range r.choices {
		if time.Now().After(v.Expires) {
			delete(r.choices, nonce)
		}
	}
	if req.Params.RequestState == "" {
		nonce := uuid.NewString()
		r.choices[nonce] = &choiceRecord{Owner: owner, Hash: hash, Expires: time.Now().Add(5 * time.Minute)}
		raw, e := protocol.Encode(map[string]any{"resultType": "input_required", "requestState": r.token(nonce), "inputRequests": map[string]any{"choice": map[string]any{"method": "elicitation/create", "params": map[string]any{"mode": "form", "message": message, "requestedSchema": schema}}}})
		if e != nil {
			return nil, e
		}
		var out mcp.CallToolResult
		if e = json.Unmarshal(raw, &out); e != nil {
			return nil, e
		}
		return &out, nil
	}
	nonce, ok := r.verify(req.Params.RequestState)
	record := r.choices[nonce]
	if !ok || record == nil || record.Owner != owner || record.Hash != hash {
		return toolError(fault.New("native_choice_changed_or_expired", 409))
	}
	if record.Result != nil {
		return record.Result, nil
	}
	if record.Running {
		return toolError(fault.New("native_choice_in_progress", 409))
	}
	answer, ok := req.Params.InputResponses["choice"].(*mcp.ElicitResult)
	if !ok {
		return toolError(fault.New("native_choice_response_invalid", 400))
	}
	if answer.Action != "accept" || answer.Content["confirm"] != true {
		delete(r.choices, nonce)
		return toolResult(map[string]any{"state": "declined", "sideEffect": false})
	}
	record.Running = true
	v, e := r.store.configureArchive(ctx, x, &scope)
	record.Running = false
	if e != nil {
		record.Result, _ = toolError(e)
		return record.Result, nil
	}
	record.Result, e = toolResult(v)
	return record.Result, e
}
