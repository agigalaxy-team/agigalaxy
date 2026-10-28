package native

import (
	"context"
	"encoding/json"
	"math"
	"path/filepath"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type UploadPrivacySettings struct {
	Version                  int      `json:"version"`
	Revision                 int64    `json:"revision"`
	Level                    string   `json:"level"`
	IncludeFullConversations bool     `json:"includeFullConversations"`
	SessionIDs               []string `json:"sessionIds"`
	UpdatedAt                *string  `json:"updatedAt,omitempty"`
}
type UploadPrivacySelection struct {
	Level                    string    `json:"level,omitempty"`
	IncludeFullConversations *bool     `json:"includeFullConversations,omitempty"`
	SessionIDs               *[]string `json:"sessionIds,omitempty"`
}

func uploadTrim(value string) string {
	return strings.Trim(value, " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
}
func uploadObject(value any) map[string]any {
	if object, ok := value.(map[string]any); ok {
		return object
	}
	raw, e := protocol.Encode(value)
	if e != nil {
		return nil
	}
	object, _ := connectionObject(raw)
	return object
}
func NormalizeUploadPrivacy(value any) UploadPrivacySettings {
	out := UploadPrivacySettings{Version: 1, Level: "history-overview", SessionIDs: []string{}}
	object := uploadObject(value)
	level := text(object["level"])
	if !isOne(level, "local-only", "history-overview", "work-content", "conversation-archive") {
		return out
	}
	out.Level = level
	if revision, ok := object["revision"].(int64); ok && revision >= 0 && revision <= 9007199254740991 {
		out.Revision = revision
	} else if revision, ok := object["revision"].(int); ok && revision >= 0 && int64(revision) <= 9007199254740991 {
		out.Revision = int64(revision)
	} else {
		var numeric float64
		valid := false
		switch number := object["revision"].(type) {
		case json.Number:
			var e error
			numeric, e = number.Float64()
			valid = e == nil
		case float64:
			numeric = number
			valid = true
		}
		if valid && numeric >= 0 && numeric <= 9007199254740991 && math.Trunc(numeric) == numeric {
			out.Revision = int64(numeric)
		}
	}
	sessions := []string{}
	switch values := object["sessionIds"].(type) {
	case []string:
		sessions = values
	case []any:
		for _, value := range values {
			if s, ok := value.(string); ok {
				sessions = append(sessions, s)
			}
		}
	}
	for _, value := range sessions {
		if protocol.TextLength(value) > 512 {
			continue
		}
		value = uploadTrim(value)
		if value != "" && !connectionIncludes(out.SessionIDs, value) && len(out.SessionIDs) < 500 {
			out.SessionIDs = append(out.SessionIDs, value)
		}
	}
	out.IncludeFullConversations = out.Level == "conversation-archive" && object["includeFullConversations"] == true && len(out.SessionIDs) > 0
	if !out.IncludeFullConversations {
		out.SessionIDs = []string{}
	}
	if stamp, ok := object["updatedAt"].(string); ok {
		out.UpdatedAt = &stamp
	}
	return out
}
func uploadSameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	set := map[string]int{}
	for _, value := range a {
		set[value]++
	}
	for _, value := range b {
		if set[value] == 0 {
			return false
		}
		set[value]--
	}
	return true
}
func SelectUploadPrivacy(current UploadPrivacySettings, input UploadPrivacySelection, updatedAt string) (UploadPrivacySettings, error) {
	current = NormalizeUploadPrivacy(current)
	level := input.Level
	if level == "" {
		level = current.Level
	}
	if !isOne(level, "local-only", "history-overview", "work-content", "conversation-archive") {
		return current, connectionFailure("upload_privacy_level_invalid")
	}
	sessions := append([]string{}, current.SessionIDs...)
	if input.SessionIDs != nil {
		if len(*input.SessionIDs) > 500 {
			return current, connectionFailure("upload_privacy_session_scope_invalid")
		}
		sessions = []string{}
		for _, value := range *input.SessionIDs {
			if protocol.TextLength(value) > 512 || uploadTrim(value) == "" {
				return current, connectionFailure("upload_privacy_session_scope_invalid")
			}
			value = uploadTrim(value)
			if !connectionIncludes(sessions, value) {
				sessions = append(sessions, value)
			}
		}
	}
	include := level == current.Level && current.IncludeFullConversations
	if input.IncludeFullConversations != nil {
		include = *input.IncludeFullConversations
	}
	if include && level != "conversation-archive" && input.IncludeFullConversations != nil && *input.IncludeFullConversations {
		return current, connectionFailure("upload_privacy_conversation_level_required")
	}
	enabled := level == "conversation-archive" && include
	if enabled && len(sessions) == 0 {
		return current, connectionFailure("upload_privacy_session_scope_required")
	}
	if !enabled {
		sessions = []string{}
	}
	if current.Level == level && current.IncludeFullConversations == enabled && uploadSameSet(current.SessionIDs, sessions) {
		return current, nil
	}
	out := UploadPrivacySettings{Version: 1, Revision: current.Revision + 1, Level: level, IncludeFullConversations: enabled, SessionIDs: sessions}
	if updatedAt != "" {
		out.UpdatedAt = &updatedAt
	}
	return out, nil
}
func AllowedUploadDataTypes(settings UploadPrivacySettings) []string {
	settings = NormalizeUploadPrivacy(settings)
	out := []string{}
	if settings.Level != "local-only" {
		out = append(out, "history-metadata", "environment-versions")
	}
	if isOne(settings.Level, "work-content", "conversation-archive") {
		out = append(out, "work-summary", "work-content", "work-artifact")
	}
	if settings.IncludeFullConversations {
		out = append(out, "full-conversation")
	}
	return out
}
func (r *Runtime) ReadUploadPrivacy(ctx context.Context, expected *ChoiceScope) (UploadPrivacySettings, string, error) {
	var settings UploadPrivacySettings
	var owner string
	e := r.store.With(ctx, false, func(dir string) error {
		if e := r.store.verifyChoiceWithin(dir, expected); e != nil {
			return e
		}
		var e error
		owner, e = r.store.ownerWithin(dir, "")
		if e != nil {
			return e
		}
		material, e := uploadPrivacyWithin(dir, owner)
		if e == nil {
			settings = material.settings
		}
		return e
	})
	return settings, owner, e
}

type uploadPrivacyMaterial struct {
	identity, state, separate map[string]any
	settings                  UploadPrivacySettings
}

func uploadPrivacyWithin(dir, owner string) (uploadPrivacyMaterial, error) {
	var material uploadPrivacyMaterial
	var e error
	if e = readFallback(dir, "galaxy-id.json", "node.json", &material.identity); e != nil {
		return material, e
	}
	if e = readFallback(dir, "galaxy-local-state.json", "local-state.json", &material.state); e != nil {
		return material, e
	}
	material.separate = map[string]any{"version": 1, "identities": map[string]any{}}
	if ok, e := readJSON(filepath.Join(dir, "galaxy-upload-privacy.json"), &material.separate); e != nil {
		return material, e
	} else if ok {
		if integer(material.separate["version"]) != 1 {
			return material, connectionFailure("local_upload_privacy_file_invalid")
		}
		if _, ok := material.separate["identities"].(map[string]any); !ok {
			return material, connectionFailure("local_upload_privacy_file_invalid")
		}
	}
	value := material.state["uploadPrivacy"]
	if owner != "" && owner != text(material.identity["id"]) {
		identities, _ := material.separate["identities"].(map[string]any)
		value = identities[owner]
		if value == nil {
			byOwner, _ := material.state["uploadPrivacyByIdentity"].(map[string]any)
			value = byOwner[owner]
		}
	}
	material.settings = NormalizeUploadPrivacy(value)
	return material, nil
}
