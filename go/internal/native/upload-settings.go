package native

import (
	"context"
	"os"
	"path/filepath"
	"regexp"

	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
)

type NativeLocalSettingsInput struct {
	ChoiceID                 string           `json:"choiceId"`
	GalaxyID                 *string          `json:"galaxyId,omitempty"`
	Level                    string           `json:"level"`
	ConversationMode         string           `json:"conversationMode"`
	Sessions                 []ArchiveSession `json:"sessions"`
	TargetAccountID          *string          `json:"targetAccountId,omitempty"`
	AutoCleanAfterDays       *int             `json:"autoCleanAfterDays"`
	RestoreArchiveSessionIDs []string         `json:"restoreArchiveSessionIds"`
}

func validateNativeLocalSettings(input NativeLocalSettingsInput) error {
	if !controlUUID(input.ChoiceID) || !isOne(input.Level, "local-only", "history-overview", "work-content", "conversation-archive") || !isOne(input.ConversationMode, "off", "local", "cloud") || input.Sessions == nil || len(input.Sessions) > 500 || len(input.RestoreArchiveSessionIDs) > 500 || input.AutoCleanAfterDays != nil && (*input.AutoCleanAfterDays < 1 || *input.AutoCleanAfterDays > 36500) || input.TargetAccountID != nil && !controlUUID(*input.TargetAccountID) || input.ConversationMode != "off" && len(input.Sessions) == 0 || input.ConversationMode == "cloud" && (input.Level != "conversation-archive" || input.TargetAccountID == nil) {
		return connectionFailure("local_settings_invalid")
	}
	for _, session := range input.Sessions {
		if !validID(session.Host) || !validID(session.SessionID) {
			return connectionFailure("local_settings_invalid")
		}
	}
	for _, id := range input.RestoreArchiveSessionIDs {
		if !controlUUID(id) {
			return connectionFailure("local_settings_invalid")
		}
	}
	return nil
}
func uploadNativeRecordWithin(dir, key string, value any) error {
	raw, e := protocol.Encode(value)
	if e != nil {
		return e
	}
	if len(raw) > 2*1024*1024 || regexp.MustCompile(`-----BEGIN (?:PRIVATE|RSA PRIVATE) KEY-----`).Match(raw) {
		return connectionFailure("native_record_invalid")
	}
	path := connectionRecordPath(dir, key)
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	return writeJSON(path, value)
}

// SaveLocalSettingsReviewed continues the original per-choice local journal.
// Archive preferences, local privacy and sync choice are separate commits. A
// failure retains completed=false so the same exact original input can resume;
// no global transaction, upload completion or background timer is claimed.
func (r *Runtime) SaveLocalSettingsReviewed(ctx context.Context, input NativeLocalSettingsInput, scope *ChoiceScope) (any, error) {
	outerContext := ctx
	ctx = context.WithValue(ctx, uploadWakeKey{}, true)
	if e := validateNativeLocalSettings(input); e != nil {
		return nil, e
	}
	if scope == nil || scope.Owner == "" {
		return nil, connectionFailure("native_connection_choice_required")
	}
	if input.GalaxyID != nil && *input.GalaxyID != "" && *input.GalaxyID != scope.Owner {
		return nil, connectionFailure("local_identity_changed")
	}
	if input.RestoreArchiveSessionIDs == nil {
		input.RestoreArchiveSessionIDs = []string{}
	}
	_, owner, e := r.ReadUploadPrivacy(ctx, scope)
	if e != nil {
		return nil, e
	}
	if owner != scope.Owner {
		return nil, connectionFailure("local_identity_changed")
	}
	key := "local-settings:" + r.config.Endpoint + ":" + owner + ":" + input.ChoiceID
	var prior map[string]any
	e = r.store.With(ctx, false, func(dir string) error {
		if e := r.store.verifyChoiceWithin(dir, scope); e != nil {
			return e
		}
		_, e := readJSON(connectionRecordPath(dir, key), &prior)
		return e
	})
	if e != nil {
		return nil, e
	}
	if prior != nil && !connectionEqual(prior["input"], input) {
		return nil, connectionFailure("local_settings_original_choice_changed")
	}
	if prior["completed"] == true {
		return map[string]any{"saved": true}, nil
	}
	archive := NewArchiveUpload(r)
	if input.ConversationMode == "cloud" {
		targets, e := r.Call(ctx, "/v2/account-archives/accounts", map[string]any{}, ConnectionCallOptions{ExpectedScope: scope})
		if e != nil {
			return nil, e
		}
		valid := false
		if targets["subjectId"] == owner {
			for _, value := range uploadRows(targets["accounts"]) {
				account := uploadObject(value)
				if account["accountId"] == *input.TargetAccountID && account["endpoint"] == r.config.Endpoint {
					valid = true
				}
			}
		}
		if !valid {
			return nil, connectionFailure("account_target_unavailable")
		}
	}
	writeJournal := func(completed bool) error {
		return r.store.With(ctx, true, func(dir string) error {
			if e := r.store.verifyChoiceWithin(dir, scope); e != nil {
				return e
			}
			var current map[string]any
			if _, e := readJSON(connectionRecordPath(dir, key), &current); e != nil {
				return e
			}
			if current != nil && !connectionEqual(current["input"], input) {
				return connectionFailure("local_settings_original_choice_changed")
			}
			return uploadNativeRecordWithin(dir, key, map[string]any{"input": input, "completed": completed})
		})
	}
	if e = writeJournal(false); e != nil {
		return nil, e
	}
	enabled := input.ConversationMode != "off"
	if _, e = r.store.configureArchive(ctx, ArchiveInput{GalaxyID: owner, Enabled: &enabled, Sessions: input.Sessions, AutoCleanAfterDays: input.AutoCleanAfterDays}, scope); e != nil {
		return nil, e
	}
	chosen := []string{}
	after := ""
	for {
		page, e := r.store.ArchiveList(ctx, ArchiveQuery{GalaxyID: owner, Limit: 100, After: after})
		if e != nil {
			return nil, e
		}
		listed := page.(map[string]any)
		for _, value := range uploadRows(listed["items"]) {
			session := uploadObject(value)
			for _, selected := range input.Sessions {
				if session["host"] == selected.Host && session["sessionId"] == selected.SessionID {
					chosen = append(chosen, text(session["archiveSessionId"]))
					break
				}
			}
		}
		after = text(listed["nextAfter"])
		if after == "" {
			break
		}
	}
	cloud := input.ConversationMode == "cloud"
	selectedIDs := []string{}
	if cloud {
		selectedIDs = chosen
	}
	if _, e = r.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: input.Level, IncludeFullConversations: &cloud, SessionIDs: &selectedIDs}, scope); e != nil {
		return nil, e
	}
	settings, e := archive.Settings(ctx)
	if e != nil {
		return nil, e
	}
	currentChoice := settings.(map[string]any)["choice"].(map[string]any)
	target := text(currentChoice["targetAccountId"])
	if input.TargetAccountID != nil {
		target = *input.TargetAccountID
	}
	restore := []string{}
	if cloud {
		restore = input.RestoreArchiveSessionIDs
	}
	if _, e = archive.ChooseReviewed(ctx, ArchiveUploadChoice{ChoiceID: input.ChoiceID, Enabled: cloud, TargetAccountID: target, ArchiveSessionIDs: chosen, RestoreArchiveSessionIDs: restore}, scope); e != nil {
		return nil, e
	}
	if e = writeJournal(true); e != nil {
		return nil, e
	}
	r.wakePrivateSync(outerContext)
	return map[string]any{"saved": true}, nil
}
