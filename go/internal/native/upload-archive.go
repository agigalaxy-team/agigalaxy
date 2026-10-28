package native

import (
	"context"
	"database/sql"
	"strings"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
)

func archiveUploadDocument(value, job map[string]any, ready bool) error {
	if value["id"] != job["id"] || value["originSubjectId"] != job["owner_id"] || value["visibility"] != "Private" || !connectionEqual(value["selection"], decoded(job["selection_json"])) || value["title"] != uploadTrim(text(job["title"])) || ready && (value["state"] != "ready" || integer(value["chunkCount"]) != integer(job["chunk_count"])) {
		return connectionFailure("archive_sync_receipt_mismatch")
	}
	return nil
}
func archiveUploadStatus(value, job map[string]any) (map[int64]bool, error) {
	if value["id"] != job["id"] || !isOne(text(value["state"]), "absent", "uploading", "ready", "deleted", "expired") {
		return nil, connectionFailure("archive_sync_receipt_mismatch")
	}
	sequences, ok := value["storedSequences"].([]any)
	if !ok {
		return nil, connectionFailure("archive_sync_receipt_mismatch")
	}
	stored := map[int64]bool{}
	for _, sequence := range sequences {
		if !connectionSafeInteger(sequence) || integer(sequence) >= integer(job["chunk_count"]) || stored[integer(sequence)] {
			return nil, connectionFailure("archive_sync_receipt_mismatch")
		}
		stored[integer(sequence)] = true
	}
	if isOne(text(value["state"]), "uploading", "ready") {
		if e := archiveUploadDocument(uploadObject(value["archive"]), job, value["state"] == "ready"); e != nil {
			return nil, e
		}
	} else if len(stored) > 0 {
		return nil, connectionFailure("archive_sync_receipt_mismatch")
	}
	return stored, nil
}
func (a *ArchiveUpload) send(ctx context.Context, job map[string]any, scope *ChoiceScope, operation string, input any, material bool) (map[string]any, error) {
	if e := a.allowed(ctx, job, scope); e != nil {
		return nil, e
	}
	options := ConnectionCallOptions{AccountID: text(job["target_id"]), ExpectedScope: scope}
	if material {
		options.LocalUpload = ConnectionLocalUpload{DataTypes: []string{"full-conversation"}, SessionID: text(job["archive_id"])}
	}
	return a.runtime.Call(ctx, "/v2/account-archives/"+operation, input, options)
}
func (a *ArchiveUpload) unknown(ctx context.Context, job map[string]any, scope *ChoiceScope, cause error) (any, error) {
	code := fault.Code(cause)
	if code == "internal_error" {
		code = "archive_sync_unavailable"
	}
	view, e := a.mark(ctx, job, scope, "unknown", code)
	if e != nil {
		return nil, e
	}
	if view["state"] == "unknown" {
		view["originalOperationRetained"] = true
	}
	return view, nil
}
func (a *ArchiveUpload) Resume(ctx context.Context, id string) (any, error) {
	if !controlUUID(id) {
		return nil, connectionFailure("archive_sync_input_invalid")
	}
	expected, e := uploadChoiceScope(ctx, a.runtime.store)
	if e != nil {
		return nil, e
	}
	job, e := a.job(ctx, id, &expected)
	if e != nil {
		return nil, e
	}
	deletion := UploadCloudQuery{TargetAccountID: text(job["target_id"]), ID: id}
	pending, e := a.runtime.uploadPendingDelete(ctx, deletion, "archive", &expected)
	if e != nil {
		return nil, e
	}
	if pending {
		result, e := a.deleteCloud(ctx, deletion, &expected, true)
		if e != nil {
			return nil, e
		}
		if uploadObject(result)["state"] == "unknown" {
			view := archiveUploadView(job)
			view["state"], view["error"], view["reconciliationRequired"] = "unknown", "cloud_delete_result_unresolved", true
			return view, nil
		}
		job, e = a.job(ctx, id, &expected)
		if e != nil {
			return nil, e
		}
	}
	if isOne(text(job["state"]), "deleted", "expired", "local-deleted") {
		return archiveUploadView(job), nil
	}
	status, e := a.send(ctx, job, &expected, "status", map[string]any{"id": id}, false)
	if e != nil {
		return a.unknown(ctx, job, &expected, e)
	}
	stored, e := archiveUploadStatus(status, job)
	if e != nil {
		return a.unknown(ctx, job, &expected, e)
	}
	if isOne(text(status["state"]), "deleted", "expired") {
		state := "deleted"
		if status["state"] == "expired" || status["reason"] == "expired" {
			state = "expired"
		}
		return a.mark(ctx, job, &expected, state, nil)
	}
	if status["state"] == "ready" {
		return a.mark(ctx, job, &expected, "ready", nil)
	}
	if job["state"] == "ready" && status["state"] == "absent" {
		return a.mark(ctx, job, &expected, "deleted", nil)
	}
	var chunks []map[string]any
	e = a.access(ctx, false, false, expected.Owner, &expected, func(db *sql.DB, owner string) error {
		if db == nil {
			return connectionFailure("archive_sync_original_snapshot_unavailable")
		}
		var e error
		chunks, e = rowsMaps(ctx, db, "SELECT sequence,content FROM sync_chunks WHERE job_id=? ORDER BY sequence", job["id"])
		return e
	})
	if e != nil {
		return a.unknown(ctx, job, &expected, e)
	}
	if len(chunks) != int(integer(job["chunk_count"])) || len(chunks) == 0 || len(chunks) > 65536 {
		return a.unknown(ctx, job, &expected, connectionFailure("archive_sync_original_snapshot_unavailable"))
	}
	var original strings.Builder
	for sequence, chunk := range chunks {
		if integer(chunk["sequence"]) != int64(sequence) || len(text(chunk["content"])) > 262144 || text(chunk["content"]) == "" {
			return a.unknown(ctx, job, &expected, connectionFailure("archive_sync_original_snapshot_unavailable"))
		}
		original.WriteString(text(chunk["content"]))
		if original.Len() > 64*1024*1024 {
			return a.unknown(ctx, job, &expected, connectionFailure("local_archive_snapshot_too_large"))
		}
	}
	snapshot, e := connectionObject([]byte(original.String()))
	if e != nil || snapshot["format"] != "galaxy-private-conversation-v1" || snapshot["galaxyId"] != job["owner_id"] || uploadObject(snapshot["session"])["archiveSessionId"] != job["archive_id"] || snapshot["completeConversation"] != false {
		return a.unknown(ctx, job, &expected, connectionFailure("archive_sync_original_snapshot_unavailable"))
	}
	if e = connectionNoCredentials(snapshot); e != nil {
		return a.unknown(ctx, job, &expected, e)
	}
	if status["state"] == "absent" {
		created, e := a.send(ctx, job, &expected, "create", map[string]any{"id": job["id"], "title": job["title"], "selection": decoded(job["selection_json"]), "uploadLevel": "conversation-archive", "includeFullConversation": true}, true)
		if e != nil {
			if fault.Code(e) == "archive_deleted" {
				current, check := a.send(ctx, job, &expected, "status", map[string]any{"id": id}, false)
				if check == nil {
					if _, check = archiveUploadStatus(current, job); check == nil && isOne(text(current["state"]), "deleted", "expired") {
						state := "deleted"
						if current["state"] == "expired" || current["reason"] == "expired" {
							state = "expired"
						}
						return a.mark(ctx, job, &expected, state, "archive_deleted")
					}
				}
			}
			return a.unknown(ctx, job, &expected, e)
		}
		if created["state"] == "ready" {
			if e = archiveUploadDocument(created, job, true); e != nil {
				return a.unknown(ctx, job, &expected, e)
			}
			return a.mark(ctx, job, &expected, "ready", nil)
		}
		if e = archiveUploadDocument(created, job, false); e != nil || created["state"] != "uploading" {
			return a.unknown(ctx, job, &expected, connectionFailure("archive_sync_receipt_mismatch"))
		}
	}
	for _, chunk := range chunks {
		sequence := integer(chunk["sequence"])
		if stored[sequence] {
			continue
		}
		receipt, e := a.send(ctx, job, &expected, "chunk", map[string]any{"id": job["id"], "sequence": sequence, "content": chunk["content"]}, true)
		if e != nil {
			return a.unknown(ctx, job, &expected, e)
		}
		if receipt["id"] != job["id"] || !connectionSafeInteger(receipt["sequence"]) || integer(receipt["sequence"]) != sequence || receipt["stored"] != true {
			return a.unknown(ctx, job, &expected, connectionFailure("archive_sync_receipt_mismatch"))
		}
	}
	completed, e := a.send(ctx, job, &expected, "complete", map[string]any{"id": job["id"], "chunkCount": job["chunk_count"]}, true)
	if e != nil {
		return a.unknown(ctx, job, &expected, e)
	}
	if e = archiveUploadDocument(completed, job, true); e != nil {
		return a.unknown(ctx, job, &expected, e)
	}
	return a.mark(ctx, job, &expected, "ready", nil)
}
