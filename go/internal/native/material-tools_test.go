package native

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func materialStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "galaxy-id.json"), []byte(`{"id":"material-owner"}`), 0600); e != nil {
		t.Fatal(e)
	}
	s, e := NewStore(dir, "https://material.invalid")
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func materialClient(t *testing.T, s *Store, version string, accept bool) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	server := mcp.NewServer(&mcp.Implementation{Name: "material-test", Version: "1"}, nil)
	rt := &toolRuntime{store: s, key: make([]byte, 32), choices: map[string]*choiceRecord{}}
	registerLocalMaterialTools(server, rt)
	ct, st := mcp.NewInMemoryTransports()
	ss, e := server.Connect(ctx, st, nil)
	if e != nil {
		t.Fatal(e)
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "material-test", Version: "1"}, &mcp.ClientOptions{ElicitationHandler: func(context.Context, *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"confirm": accept}}, nil
	}})
	cs, e := client.Connect(ctx, ct, &mcp.ClientSessionOptions{ProtocolVersion: version})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cs.Close(); ss.Close() })
	return cs
}
func materialCall(t *testing.T, c *mcp.ClientSession, name string, args any, wantError bool) map[string]any {
	t.Helper()
	r, e := c.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if e != nil {
		t.Fatal(e)
	}
	if r.IsError != wantError {
		t.Fatalf("%s error=%v result=%v", name, r.IsError, r.Content)
	}
	if len(r.Content) != 1 {
		t.Fatalf("non-text-only result: %v", r)
	}
	text, ok := r.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("result is not text: %v", r)
	}
	var out map[string]any
	if e = json.Unmarshal([]byte(text.Text), &out); e != nil {
		t.Fatal(e)
	}
	return out
}
func TestMaterialPublicToolsStrictSchemasAndPersonDelete(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		t.Run(version, func(t *testing.T) {
			s := materialStore(t)
			c := materialClient(t, s, version, true)
			for _, args := range []any{map[string]any{"host": "opencode", "sessionId": "s"}, map[string]any{"host": "opencode", "sessionId": "s", "text": nil}, map[string]any{"host": "opencode", "sessionId": "s", "text": "x", "sourceKind": "host-event"}, map[string]any{"host": "opencode", "sessionId": "s", "text": "x", "unexpected": true}, map[string]any{"host": "opencode", "sessionId": "s", "text": "x", "title": strings.Repeat("😀", 91)}} {
				materialCall(t, c, "galaxy_local_work_note", args, true)
			}
			note := materialCall(t, c, "galaxy_local_work_note", map[string]any{"host": "opencode", "sessionId": "s", "text": "model statement", "sourceId": "statement"}, false)
			workID := note["workId"].(string)
			ob := note["observation"].(map[string]any)
			if ob["source"].(map[string]any)["kind"] != "model-report" {
				t.Fatal("note impersonated host")
			}
			summary := map[string]any{"workId": workID, "expectedRevision": 0, "throughSequence": ob["sequence"], "sourceObservationIds": []any{ob["id"]}, "title": "Summary", "summary": "User model interpretation"}
			missing := map[string]any{}
			for k, v := range summary {
				if k != "expectedRevision" {
					missing[k] = v
				}
			}
			materialCall(t, c, "galaxy_local_work_summary", missing, true)
			bad := map[string]any{}
			for k, v := range summary {
				bad[k] = v
			}
			bad["execution"] = map[string]any{"host": "opencode"}
			materialCall(t, c, "galaxy_local_work_summary", bad, true)
			saved := materialCall(t, c, "galaxy_local_work_summary", summary, false)
			if saved["sourceKind"] != "user-model" {
				t.Fatal("summary source lost")
			}
			materialCall(t, c, "galaxy_local_archive_export", map[string]any{"archiveSessionId": "00000000000000000000000000000000"}, true)
			materialCall(t, c, "galaxy_local_archive_list", map[string]any{"limit": 0}, true)
			materialCall(t, c, "galaxy_local_archive_cleanup", map[string]any{"galaxyId": nil}, true)
			declined := materialClient(t, s, version, false)
			r := materialCall(t, declined, "galaxy_local_work_delete", map[string]any{"workId": workID}, false)
			if r["state"] != "declined" {
				t.Fatal("delete bypassed decline")
			}
			if got, e := s.WorkGet(context.Background(), WorkQuery{WorkID: workID}); e != nil || got == nil {
				t.Fatal("declined source removed")
			}
			materialCall(t, c, "galaxy_local_work_delete", map[string]any{"workId": workID}, false)
			if got, e := s.WorkGet(context.Background(), WorkQuery{WorkID: workID}); e != nil || got != nil {
				t.Fatal("accepted source retained")
			}
			if present, _ := exists(filepath.Join(s.Directory, "work-history", "sync.sqlite")); present {
				t.Fatal("delete created unused sync database")
			}
			enabled := true
			if _, e := s.ConfigureArchive(context.Background(), ArchiveInput{Enabled: &enabled, Sessions: []ArchiveSession{{Host: "opencode", SessionID: "s"}}}); e != nil {
				t.Fatal(e)
			}
			capture, e := s.CaptureArchiveMessage(context.Background(), ArchiveCaptureInput{Host: "opencode", SessionID: "s", MessageID: "m", Message: json.RawMessage(`{"id":"m"}`), Parts: json.RawMessage(`[]`)})
			if e != nil {
				t.Fatal(e)
			}
			archiveID := capture.(map[string]any)["archiveSessionId"].(string)
			materialCall(t, c, "galaxy_local_archive_list", map[string]any{}, false)
			exported := materialCall(t, c, "galaxy_local_archive_export", map[string]any{"archiveSessionId": archiveID}, false)
			if len(exported["messages"].([]any)) != 1 || exported["completeConversation"] != false {
				t.Fatal("public archive scope changed")
			}
			materialCall(t, c, "galaxy_local_archive_cleanup", map[string]any{}, false)
			r = materialCall(t, declined, "galaxy_local_archive_delete", map[string]any{"archiveSessionId": archiveID}, false)
			if r["state"] != "declined" {
				t.Fatal("archive delete bypassed decline")
			}
			materialCall(t, c, "galaxy_local_archive_delete", map[string]any{"archiveSessionId": archiveID}, false)
			if got, e := s.ArchiveDescribe(context.Background(), ArchiveQuery{ArchiveSessionID: archiveID}); e != nil || got != nil {
				t.Fatal("accepted archive retained")
			}
		})
	}
}

func TestArchiveDeleteCancelsOnlyExactQueueAndRollsBackChunksOnFailure(t *testing.T) {
	ctx := context.Background()
	s := materialStore(t)
	enabled := true
	if _, e := s.ConfigureArchive(ctx, ArchiveInput{Enabled: &enabled, Sessions: []ArchiveSession{{Host: "opencode", SessionID: "s"}}}); e != nil {
		t.Fatal(e)
	}
	capture, e := s.CaptureArchiveMessage(ctx, ArchiveCaptureInput{Host: "opencode", SessionID: "s", MessageID: "m", Message: json.RawMessage(`{"id":"m"}`), Parts: json.RawMessage(`[]`)})
	if e != nil {
		t.Fatal(e)
	}
	archiveID := capture.(map[string]any)["archiveSessionId"].(string)
	file := filepath.Join(s.Directory, "conversation-archive", "sync.sqlite")
	if e = os.WriteFile(file, nil, 0600); e != nil {
		t.Fatal(e)
	}
	db, e := openSQLite(file, true)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	if _, e = db.ExecContext(ctx, `CREATE TABLE sync_jobs(id TEXT PRIMARY KEY,owner_id TEXT,endpoint TEXT,archive_id TEXT,state TEXT,updated_at TEXT);CREATE TABLE sync_chunks(job_id TEXT,sequence INTEGER,content TEXT);`); e != nil {
		t.Fatal(e)
	}
	for i, values := range [][]string{{"material-owner", s.Endpoint, archiveID}, {"other-owner", s.Endpoint, archiveID}, {"material-owner", "https://other.invalid", archiveID}, {"material-owner", s.Endpoint, "other-source"}} {
		if _, e = db.ExecContext(ctx, "INSERT INTO sync_jobs VALUES(?,?,?,?,?,?)", i, values[0], values[1], values[2], "prepared", "unchanged"); e != nil {
			t.Fatal(e)
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO sync_chunks VALUES(?,1,'fake chunk')", i); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = db.ExecContext(ctx, `CREATE TRIGGER stop_cancel BEFORE UPDATE ON sync_jobs WHEN NEW.state='local-deleted' BEGIN SELECT RAISE(ABORT,'isolated queue failure');END;`); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ArchiveDelete(ctx, ArchiveQuery{ArchiveSessionID: archiveID}); fault.Code(e) != "local_archive_queue_cancel_failed" {
		t.Fatalf("archive queue failure not preserved: %v", e)
	}
	if found, e := s.ArchiveDescribe(ctx, ArchiveQuery{ArchiveSessionID: archiveID}); e != nil || found == nil {
		t.Fatal("failed cancellation removed original")
	}
	r, e := oneMap(ctx, db, "SELECT count(*) AS count FROM sync_chunks")
	if e != nil || integer(r["count"]) != 4 {
		t.Fatal("queue failure committed chunk deletion")
	}
	if _, e = db.ExecContext(ctx, "DROP TRIGGER stop_cancel"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.ArchiveDelete(ctx, ArchiveQuery{ArchiveSessionID: archiveID}); e != nil {
		t.Fatal(e)
	}
	rows, e := rowsMaps(ctx, db, "SELECT j.*, (SELECT count(*) FROM sync_chunks c WHERE c.job_id=j.id) chunks FROM sync_jobs j ORDER BY id")
	if e != nil {
		t.Fatal(e)
	}
	for i, r := range rows {
		if i == 0 {
			if r["state"] != "local-deleted" || integer(r["chunks"]) != 0 {
				t.Fatal("selected archive queue retained")
			}
		} else if r["state"] != "prepared" || integer(r["chunks"]) != 1 || r["updated_at"] != "unchanged" {
			t.Fatal("unrelated archive owner/endpoint/source changed")
		}
	}
}

func TestLocalDeleteCancelsOnlyExactExistingQueueAndRollsBackOnFailure(t *testing.T) {
	ctx := context.Background()
	s := materialStore(t)
	observed, e := s.RecordWorkNote(ctx, WorkNoteInput{Host: "opencode", SessionID: "s", Text: "test statement"})
	if e != nil {
		t.Fatal(e)
	}
	workID := observed.(map[string]any)["workId"].(string)
	file := filepath.Join(s.Directory, "work-history", "sync.sqlite")
	if e = os.WriteFile(file, nil, 0600); e != nil {
		t.Fatal(e)
	}
	db, e := openSQLite(file, true)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	_, e = db.ExecContext(ctx, `CREATE TABLE work_sync_jobs(id TEXT PRIMARY KEY,owner_id TEXT,endpoint TEXT,work_id TEXT,state TEXT,data_json TEXT);CREATE TABLE work_sync_scopes(owner_id TEXT,endpoint TEXT,work_id TEXT,blocked INTEGER);`)
	if e != nil {
		t.Fatal(e)
	}
	for i, values := range [][]string{{"material-owner", s.Endpoint, workID}, {"other-owner", s.Endpoint, workID}, {"material-owner", "https://other.invalid", workID}, {"material-owner", s.Endpoint, "other-source"}} {
		if _, e = db.ExecContext(ctx, "INSERT INTO work_sync_jobs VALUES(?,?,?,?,?,?)", i, values[0], values[1], values[2], "prepared", `{"retained":"fake"}`); e != nil {
			t.Fatal(e)
		}
		if _, e = db.ExecContext(ctx, "INSERT INTO work_sync_scopes VALUES(?,?,?,0)", values[0], values[1], values[2]); e != nil {
			t.Fatal(e)
		}
	}
	if _, e = db.ExecContext(ctx, `CREATE TRIGGER stop_cancel BEFORE UPDATE ON work_sync_jobs WHEN NEW.state='local-deleted' BEGIN SELECT RAISE(ABORT,'isolated queue failure');END;`); e != nil {
		t.Fatal(e)
	}
	if _, e = s.DeleteWork(ctx, WorkQuery{WorkID: workID}); fault.Code(e) != "local_work_queue_cancel_failed" {
		t.Fatalf("queue failure not preserved: %v", e)
	}
	if got, e := s.WorkGet(ctx, WorkQuery{WorkID: workID}); e != nil || got == nil {
		t.Fatal("queue failure deleted source")
	}
	if _, e = db.ExecContext(ctx, "DROP TRIGGER stop_cancel"); e != nil {
		t.Fatal(e)
	}
	if _, e = s.DeleteWork(ctx, WorkQuery{WorkID: workID}); e != nil {
		t.Fatal(e)
	}
	rows, e := rowsMaps(ctx, db, "SELECT * FROM work_sync_jobs ORDER BY id")
	if e != nil {
		t.Fatal(e)
	}
	for i, r := range rows {
		if i == 0 {
			if r["state"] != "local-deleted" || r["data_json"] != "null" {
				t.Fatal("selected queue body retained")
			}
		} else if r["state"] != "prepared" || r["data_json"] != `{"retained":"fake"}` {
			t.Fatal("unrelated owner/endpoint/source queue changed")
		}
	}
	scopes, e := rowsMaps(ctx, db, "SELECT * FROM work_sync_scopes ORDER BY rowid")
	if e != nil {
		t.Fatal(e)
	}
	for i, r := range scopes {
		want := int64(0)
		if i == 0 {
			want = 1
		}
		if integer(r["blocked"]) != want {
			t.Fatal("wrong source scope blocked")
		}
	}
}
