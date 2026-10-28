package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/google/uuid"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"strings"
	"time"
)

func (s *Store) archiveChoiceMessage(ctx context.Context, x ArchiveInput) (string, error) {
	var message strings.Builder
	message.WriteString("保存本机原会话范围，不上传，也不启动模型。\n后续采集：")
	if *x.Enabled {
		message.WriteString("开启")
	} else {
		message.WriteString("关闭")
	}
	message.WriteString("\n会话范围：")
	e := s.history(ctx, x.GalaxyID, func(db *sql.DB, owner string) error {
		if len(x.Sessions) == 0 {
			message.WriteString("无")
		}
		for _, selected := range x.Sessions {
			title := selected.SessionID
			if db != nil {
				row, e := findWork(ctx, db, owner, WorkQuery{Host: selected.Host, SessionID: selected.SessionID})
				if e != nil {
					return e
				}
				if row != nil {
					if name := text(row["title"]); name != "" {
						title = name
					}
					summary, e := oneMap(ctx, db, "SELECT title FROM work_summaries WHERE work_id=? ORDER BY revision DESC LIMIT 1", row["id"])
					if e != nil {
						return e
					}
					if name := text(summary["title"]); name != "" {
						title = name
					}
				}
			}
			message.WriteString("\n• " + selected.Host + " · " + title)
		}
		return nil
	})
	if e != nil {
		return "", e
	}
	if x.AutoCleanAfterDays == nil {
		message.WriteString("\n自动清理：不启用。")
	} else {
		fmt.Fprintf(&message, "\n自动清理：超过 %d 天的本机原件。保存选择时会执行现有到期清理。", *x.AutoCleanAfterDays)
	}
	message.WriteString("\n不删除宿主自己的会话，不改变云端副本。")
	return message.String(), nil
}

func (r *toolRuntime) review(ctx context.Context, req *mcp.CallToolRequest, input any, message string, run func(*ChoiceScope) (any, error)) (*mcp.CallToolResult, error) {
	scope, e := r.store.ChoiceScope(ctx)
	if e != nil {
		return toolError(e)
	}
	owner := scope.Owner
	if owner == "" && !isOne(req.Params.Name, "galaxy_native_initialize", "galaxy_device_offer", "galaxy_device_accept","galaxy_local_worker_identity_create") {
		return toolError(fault.New("local_identity_required", 409))
	}
	rawInput, e := protocol.Encode(input)
	if e != nil {
		return toolError(e)
	}
	var ownerInput struct {
		GalaxyID string `json:"galaxyId"`
	}
	if json.Unmarshal(rawInput, &ownerInput) != nil {
		return toolError(fault.New("native_choice_input_invalid", 400))
	}
	if ownerInput.GalaxyID != "" && ownerInput.GalaxyID != owner {
		return toolError(fault.New("local_identity_mismatch", 409))
	}
	canonical, e := identity.Canonical(struct {
		Tool  string
		Input any
		Scope ChoiceScope
	}{req.Params.Name, input, scope})
	if e != nil {
		return toolError(e)
	}
	hash := identity.Digest(canonical)
	schema := objectSchema(map[string]any{"confirm": map[string]any{"type": "boolean", "title": "允许这里显示的内容与范围"}}, "confirm")
	caps := req.ClientCapabilities()
	// Empty legacy elicitation capabilities imply form support per MCP. A
	// URL-only or absent capability does not acquire form support by version.
	if caps == nil || caps.Elicitation == nil || caps.Elicitation.Form == nil && caps.Elicitation.URL != nil {
		v, e := r.browser.Review(ctx, BrowserChoiceInput{Name: req.Params.Name, Input: input, Message: message, Scope: scope}, run)
		if e != nil {
			return toolError(e)
		}
		return toolResult(v)
	}
	if req.ProtocolVersion() != "2026-07-28" {
		answer, e := req.Session.Elicit(ctx, &mcp.ElicitParams{Mode: "form", Message: message, RequestedSchema: schema})
		if e != nil {
			return toolError(fault.New("native_choice_unavailable", 503))
		}
		if answer.Action != "accept" || answer.Content["confirm"] != true {
			return toolResult(map[string]any{"state": "declined", "sideEffect": false})
		}
		v, e := run(&scope)
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
	v, e := run(&scope)
	record.Running = false
	if e != nil {
		record.Result, _ = toolError(e)
		return record.Result, nil
	}
	record.Result, e = toolResult(v)
	return record.Result, e
}
