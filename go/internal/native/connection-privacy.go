package native

import (
	"context"
	"encoding/json"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type ConnectionLocalUpload struct {
	DataTypes []string
	SessionID string
}

var connectionPublicAccountPath = regexp.MustCompile(`^/v1/account/public/(?:([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})/(ids|credentials|posts)|by-id/(GUID1[0-5][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}))$`)

func connectionPublicAccountQuery(path string) bool {
	parts := strings.Split(path, "?")
	if len(parts) != 2 {
		return false
	}
	matches := connectionPublicAccountPath.FindStringSubmatch(parts[0])
	if matches == nil {
		return false
	}
	query, e := url.ParseQuery(parts[1])
	if e != nil || len(query) == 0 {
		return false
	}
	for key, values := range query {
		if len(values) != 1 {
			return false
		}
		v := values[0]
		switch key {
		case "limit":
			if !regexp.MustCompile(`^(?:[1-9]|[1-4][0-9]|50)$`).MatchString(v) {
				return false
			}
		case "after":
			if protocol.TextLength(v) > 512 {
				return false
			}
			if matches[2] == "posts" {
				if !regexp.MustCompile(`^fp1\.[A-Za-z0-9_-]+$`).MatchString(v) {
					return false
				}
			} else if matches[2] == "ids" {
				if !connectionSubject.MatchString(v) {
					return false
				}
			} else if !regexp.MustCompile(`^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$`).MatchString(v) {
				return false
			}
		default:
			return false
		}
	}
	return true
}
func connectionNoCredentials(v any) error {
	safe, e := localdata.Redact(v)
	if e != nil {
		return e
	}
	for _, excluded := range safe.Exclusions {
		if excluded.Kind == "credential" {
			return connectionFailure("local_work_credentials_excluded")
		}
	}
	return nil
}
func (c *Connection) checkUpload(ctx context.Context, path string, input any, method string, lease connectionLease, options ConnectionLocalUpload) error {
	if input == nil || method == "GET" {
		return nil
	}
	raw, e := protocol.Encode(input)
	if e != nil {
		return e
	}
	var value map[string]any
	d := json.NewDecoder(strings.NewReader(string(raw)))
	d.UseNumber()
	if e = d.Decode(&value); e != nil {
		return connectionFailure("local_upload_payload_invalid")
	}
	payload := value
	if text, ok := value["payloadJson"].(string); ok {
		payload, e = connectionObject([]byte(text))
		if e != nil {
			return connectionFailure("local_upload_payload_invalid")
		}
	}
	level := "history-overview"
	includeFull := false
	sessions := []string{}
	e = c.store.With(ctx, false, func(dir string) error {
		selected, e := c.selectionWithin(dir)
		if e != nil {
			return e
		}
		if selected.fingerprint != lease.selection.fingerprint {
			return connectionFailure("native_connection_selection_changed")
		}
		owner := ""
		if selected.Active != nil {
			owner = selected.Active.SubjectID
		}
		var local map[string]any
		if e = readFallback(dir, "galaxy-id.json", "node.json", &local); e != nil {
			return e
		}
		if owner == "" {
			owner = text(local["id"])
		}
		var state map[string]any
		if e = readFallback(dir, "galaxy-local-state.json", "local-state.json", &state); e != nil {
			return e
		}
		var separate map[string]any
		ok, e := readJSON(filepath.Join(dir, "galaxy-upload-privacy.json"), &separate)
		if e != nil {
			return e
		}
		if ok {
			if integer(separate["version"]) != 1 {
				return connectionFailure("local_upload_privacy_file_invalid")
			}
			if _, ok := separate["identities"].(map[string]any); !ok {
				return connectionFailure("local_upload_privacy_file_invalid")
			}
		}
		settings, _ := state["uploadPrivacy"].(map[string]any)
		if owner != "" && owner != text(local["id"]) {
			identities, _ := separate["identities"].(map[string]any)
			settings, _ = identities[owner].(map[string]any)
			if settings == nil {
				byID, _ := state["uploadPrivacyByIdentity"].(map[string]any)
				settings, _ = byID[owner].(map[string]any)
			}
		}
		configured := text(settings["level"])
		if isOne(configured, "local-only", "history-overview", "work-content", "conversation-archive") {
			level = configured
		}
		if level == "conversation-archive" && settings["includeFullConversations"] == true {
			if values, ok := connectionStrings(settings["sessionIds"]); ok {
				for _, v := range values {
					v = strings.TrimSpace(v)
					if v != "" && protocol.TextLength(v) <= 512 && !connectionIncludes(sessions, v) && len(sessions) < 500 {
						sessions = append(sessions, v)
					}
				}
				includeFull = len(sessions) > 0
			}
		}
		return nil
	})
	if e != nil {
		return e
	}
	allows := func(kind, session string) bool {
		if kind == "full-conversation" {
			return includeFull && connectionIncludes(sessions, session)
		}
		if level == "local-only" {
			return false
		}
		if kind == "history-metadata" || kind == "environment-versions" {
			return true
		}
		return (level == "work-content" || level == "conversation-archive") && isOne(kind, "work-summary", "work-content", "work-artifact")
	}
	required := append([]string{}, options.DataTypes...)
	if path == "/v2/context/grants" {
		if materials, ok := payload["materials"].([]any); ok && len(materials) > 0 {
			required = append(required, "work-content")
			if e = connectionNoCredentials(materials); e != nil {
				return e
			}
		}
	}
	if path == "/v2/personal-summaries/put" && value["content"] != nil {
		required = append(required, "work-summary")
		if e = connectionNoCredentials(value["content"]); e != nil {
			return e
		}
		content, _ := value["content"].(map[string]any)
		fragments, _ := content["fragments"].([]any)
		for _, fragment := range fragments {
			f, _ := fragment.(map[string]any)
			if f["kind"] == "personal-note" {
				required = append(required, "work-content")
			}
		}
	}
	if regexp.MustCompile(`^/v2/cases/(?:events|[^/]+/events)$`).MatchString(path) {
		required = append(required, "work-summary")
	}
	if localContext, exists := value["localContext"]; exists {
		items, ok := localContext.([]any)
		if !ok {
			return connectionFailure("local_upload_data_type_required")
		}
		for _, item := range items {
			m, ok := item.(map[string]any)
			if !ok || !isOne(text(m["dataType"]), "history-metadata", "environment-versions", "work-summary", "work-content", "work-artifact", "full-conversation") {
				return connectionFailure("local_upload_data_type_required")
			}
			if e = connectionNoCredentials(m); e != nil {
				return e
			}
			if !allows(text(m["dataType"]), text(m["sessionId"])) {
				return connectionFailure("local_upload_type_not_allowed")
			}
		}
	}
	for _, kind := range required {
		if !allows(kind, options.SessionID) {
			return connectionFailure("local_upload_type_not_allowed")
		}
	}
	if len(options.DataTypes) > 0 {
		return connectionNoCredentials(payload)
	}
	return nil
}
