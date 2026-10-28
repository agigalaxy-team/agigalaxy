package native

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"github.com/google/uuid"
)

func archiveSplitUTF8(text []byte) ([]string, error) {
	if len(text) > 64*1024*1024 {
		return nil, connectionFailure("local_archive_snapshot_too_large")
	}
	chunks := []string{}
	for start := 0; start < len(text); {
		end := min(start+262144, len(text))
		for end < len(text) && text[end]&0xc0 == 0x80 {
			end--
		}
		if end <= start {
			return nil, connectionFailure("local_archive_snapshot_invalid")
		}
		chunks = append(chunks, string(text[start:end]))
		start = end
	}
	return chunks, nil
}
func (a *ArchiveUpload) Prepare(ctx context.Context, archiveID string, afterSequence int64) (any, error) {
	if !controlUUID(archiveID) || afterSequence < 0 || afterSequence > 9007199254740991 {
		return nil, connectionFailure("archive_sync_input_invalid")
	}
	expected, e := uploadChoiceScope(ctx, a.runtime.store)
	if e != nil {
		return nil, e
	}
	var choice map[string]any
	e = a.access(ctx, false, false, expected.Owner, &expected, func(db *sql.DB, owner string) error {
		var e error
		choice, e = archiveUploadChoice(ctx, db, owner, a.runtime.config.Endpoint)
		return e
	})
	if e != nil {
		return nil, e
	}
	ids, _ := connectionStrings(choice["archiveSessionIds"])
	if choice["enabled"] != true || !connectionIncludes(ids, archiveID) {
		return map[string]any{"state": "not-selected", "networkStarted": false}, nil
	}
	value, e := a.runtime.store.ArchiveSnapshot(ctx, ArchiveQuery{GalaxyID: expected.Owner, ArchiveSessionID: archiveID, AfterSequence: afterSequence})
	if e != nil {
		return nil, e
	}
	source := value.(map[string]any)
	if len(uploadRows(source["messages"])) == 0 {
		return map[string]any{"state": "empty", "archiveSessionId": archiveID, "networkStarted": false}, nil
	}
	privacy, owner, e := a.runtime.ReadUploadPrivacy(ctx, &expected)
	if e != nil {
		return nil, e
	}
	if owner != expected.Owner || !privacy.IncludeFullConversations || !connectionIncludes(privacy.SessionIDs, archiveID) {
		return nil, connectionFailure("upload_privacy_conversation_scope_not_allowed")
	}
	session := uploadObject(source["session"])
	snapshot := map[string]any{"format": "galaxy-private-conversation-v1", "galaxyId": source["galaxyId"], "session": source["session"], "messages": source["messages"], "nextAfter": source["nextAfter"], "coverage": source["coverage"], "completeConversation": source["completeConversation"]}
	if coverage, ok := source["selectedCoverage"]; ok {
		snapshot["selectedCoverage"] = coverage
	}
	if e = connectionNoCredentials(snapshot); e != nil {
		return nil, e
	}
	encoded, e := localdata.Encode(snapshot)
	if e != nil {
		return nil, e
	}
	chunks, e := archiveSplitUTF8(encoded)
	if e != nil {
		return nil, e
	}
	related, e := a.runtime.store.WorkGet(ctx, WorkQuery{GalaxyID: expected.Owner, Host: text(session["host"]), SessionID: text(session["sessionId"]), Limit: 1})
	if e != nil {
		return nil, e
	}
	title := ""
	if related != nil {
		title = text(uploadObject(related.(map[string]any)["work"])["title"])
	}
	if title == "" || isOne(title, "Recorded work", "Unprocessed work") {
		date := text(session["updatedAt"])
		if len(date) > 10 {
			date = date[:10]
		}
		title = text(session["host"]) + " · " + date + "的对话"
	}
	title = truncateJS(title, 240)
	scopeID := uploadObject(choice["scopeIds"])[archiveID]
	if !controlUUID(scopeID) {
		return nil, connectionFailure("archive_sync_scope_changed")
	}
	var version any = integer(session["revision"])
	if afterSequence > 0 || source["nextAfter"] != nil {
		suffix := "more"
		if source["nextAfter"] == nil {
			suffix = "done"
		}
		version = fmt.Sprintf("%d:%d:%d:%s", integer(session["revision"]), afterSequence, integer(uploadObject(source["selectedCoverage"])["throughSequence"]), suffix)
	}
	var out any
	e = a.access(ctx, true, false, expected.Owner, &expected, func(db *sql.DB, currentOwner string) error {
		if db == nil {
			return connectionFailure("archive_sync_scope_changed")
		}
		current, e := archiveUploadChoice(ctx, db, currentOwner, a.runtime.config.Endpoint)
		if e != nil {
			return e
		}
		if current["enabled"] != true || current["choiceId"] != choice["choiceId"] || current["targetAccountId"] != choice["targetAccountId"] || uploadObject(current["scopeIds"])[archiveID] != scopeID {
			return connectionFailure("archive_sync_scope_changed")
		}
		withdrawn, e := oneMap(ctx, db, "SELECT id FROM sync_jobs WHERE owner_id=? AND endpoint=? AND archive_id=? AND scope_id=? AND state='deleted' LIMIT 1", currentOwner, a.runtime.config.Endpoint, archiveID, scopeID)
		if e != nil {
			return e
		}
		if withdrawn != nil {
			out = map[string]any{"state": "owner-deleted", "archiveSessionId": archiveID, "networkStarted": false}
			return nil
		}
		existing, e := oneMap(ctx, db, "SELECT * FROM sync_jobs WHERE owner_id=? AND endpoint=? AND target_id=? AND archive_id=? AND source_revision=? AND scope_id=?", currentOwner, a.runtime.config.Endpoint, choice["targetAccountId"], archiveID, version, scopeID)
		if e != nil {
			return e
		}
		if existing != nil {
			out = map[string]any{"job": archiveUploadView(existing), "nextAfter": source["nextAfter"]}
			return nil
		}
		workspace := session["workspaceId"]
		if workspace == nil {
			workspace = "unknown"
		}
		selection := map[string]any{"workspaceId": workspace, "sessionIds": []any{session["sessionId"]}, "scopeId": scopeID}
		id := uuid.NewString()
		stamp := localNow()
		if _, e = db.ExecContext(ctx, "INSERT INTO sync_jobs(id,owner_id,endpoint,target_id,archive_id,source_revision,scope_id,choice_id,title,selection_json,state,chunk_count,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'prepared',?,?,?)", id, currentOwner, a.runtime.config.Endpoint, choice["targetAccountId"], archiveID, version, scopeID, choice["choiceId"], title, jsJSON(selection), len(chunks), stamp, stamp); e != nil {
			return e
		}
		for sequence, content := range chunks {
			if _, e = db.ExecContext(ctx, "INSERT INTO sync_chunks(job_id,sequence,content) VALUES(?,?,?)", id, sequence, content); e != nil {
				return e
			}
		}
		job, e := oneMap(ctx, db, "SELECT * FROM sync_jobs WHERE id=?", id)
		if e != nil {
			return e
		}
		out = map[string]any{"job": archiveUploadView(job), "nextAfter": source["nextAfter"]}
		return nil
	})
	return out, e
}
