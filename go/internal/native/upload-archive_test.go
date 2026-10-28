package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/google/uuid"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestArchiveUploadOriginalChunkLostACKAndSettingsJournal(t *testing.T) {
	store, meta, transport := workUploadServiceFixture(t)
	ctx := context.Background()
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	enabled := true
	sessions := []ArchiveSession{{Host: "opencode", SessionID: "opaque-session"}}
	if _, e = store.configureArchive(ctx, ArchiveInput{GalaxyID: scope.Owner, Enabled: &enabled, Sessions: sessions}, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = store.CaptureArchiveMessage(ctx, ArchiveCaptureInput{GalaxyID: scope.Owner, Host: "opencode", SessionID: "opaque-session", MessageID: "synthetic-original", Message: json.RawMessage(`{"role":"user"}`), Parts: json.RawMessage(`[{"type":"text","text":"隔离原件内容"}]`)}); e != nil {
		t.Fatal(e)
	}
	input := NativeLocalSettingsInput{ChoiceID: uuid.NewString(), GalaxyID: &scope.Owner, Level: "conversation-archive", ConversationMode: "cloud", Sessions: sessions, TargetAccountID: &meta.TargetID, RestoreArchiveSessionIDs: []string{}}
	if _, e = rt.SaveLocalSettingsReviewed(ctx, input, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = rt.SaveLocalSettingsReviewed(ctx, input, &scope); e != nil {
		t.Fatal(e)
	}
	changed := input
	changed.Level = "work-content"
	if _, e = rt.SaveLocalSettingsReviewed(ctx, changed, &scope); e == nil {
		t.Fatal("original settings choice input changed")
	}
	a := NewArchiveUpload(rt)
	settings, e := a.Settings(ctx)
	if e != nil {
		t.Fatal(e)
	}
	ids, _ := connectionStrings(uploadObject(settings.(map[string]any)["choice"])["archiveSessionIds"])
	if len(ids) != 1 {
		t.Fatalf("selection not resolved: %v", settings)
	}
	prepared, e := a.Prepare(ctx, ids[0], 0)
	if e != nil {
		t.Fatal(e)
	}
	id := text(uploadObject(prepared.(map[string]any)["job"])["id"])
	if id == "" {
		t.Fatalf("no immutable snapshot: %v", prepared)
	}
	chunks := 0
	drop := true
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/account-archives/chunk" {
			chunks++
			if drop {
				drop = false
				response.Body.Close()
				return nil, io.ErrUnexpectedEOF
			}
		}
		return response, nil
	})
	result, e := a.Resume(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	if result.(map[string]any)["state"] != "unknown" || chunks != 1 {
		t.Fatalf("lost ACK: %v chunks=%d", result, chunks)
	}
	result, e = a.Resume(ctx, id)
	if e != nil {
		t.Fatal(e)
	}
	if result.(map[string]any)["state"] != "ready" || chunks != 1 {
		t.Fatalf("stored chunk resent: %v chunks=%d", result, chunks)
	}
	if flushed, e := a.Flush(ctx, ids[0]); e != nil || uploadObject(flushed)["state"] != "processed" || chunks != 1 {
		t.Fatalf("saved-scope flush: %v %v chunks=%d", e, flushed, chunks)
	}
	exported, e := rt.Call(ctx, "/v2/account-archives/export", map[string]any{"id": id, "sequence": 0}, ConnectionCallOptions{AccountID: meta.TargetID})
	if e != nil {
		t.Fatal(e)
	}
	raw := text(exported["content"])
	var body map[string]any
	if e = json.Unmarshal([]byte(raw), &body); e != nil {
		t.Fatalf("export: %v %v", e, exported)
	}
	if body["format"] != "galaxy-private-conversation-v1" || body["galaxyId"] != scope.Owner || body["completeConversation"] != false {
		t.Fatalf("original coverage lost: %v", body)
	}
	if e = a.access(ctx, false, false, scope.Owner, &scope, func(db *sql.DB, _ string) error {
		row, e := oneMap(ctx, db, "SELECT count(*) AS n FROM sync_chunks WHERE job_id=?", id)
		if e == nil && integer(row["n"]) != 0 {
			t.Fatal("confirmed snapshot chunks retained")
		}
		return e
	}); e != nil {
		t.Fatal(e)
	}
	if _, e = rt.Call(ctx, "/v2/account-archives/delete", map[string]any{"id": id}, ConnectionCallOptions{AccountID: meta.TargetID}); e != nil {
		t.Fatal(e)
	}
	result, e = a.Resume(ctx, id)
	if e != nil || result.(map[string]any)["state"] != "deleted" {
		t.Fatalf("owner tombstone: %v %v", e, result)
	}
	prepared, e = a.Prepare(ctx, ids[0], 0)
	if e != nil || prepared.(map[string]any)["state"] != "owner-deleted" {
		t.Fatalf("deleted source silently recreated: %v %v", e, prepared)
	}
}
