package native

import (
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/localdata"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func materialJS(t *testing.T, dir, body string) map[string]any {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	root := filepath.ToSlash(filepath.Clean(filepath.Join(filepath.Dir(file), "../../..")))
	script := `import {createLocalWorkHistory} from 'file:///` + root + `/packages/galaxy-core/src/work-history/index.mjs';import {createLocalConversationArchive} from 'file:///` + root + `/packages/galaxy-core/src/conversation-archive/index.mjs';const dir=process.argv[1],h=createLocalWorkHistory({dataDirectory:dir}),a=createLocalConversationArchive({dataDirectory:dir});` + body
	cmd := exec.Command("node", "--input-type=module", "-e", script, dir)
	b, e := cmd.Output()
	if e != nil {
		if ex, ok := e.(*exec.ExitError); ok {
			t.Fatalf("original JS material: %v %s", e, ex.Stderr)
		}
		t.Fatal(e)
	}
	var v map[string]any
	if e = json.Unmarshal(b, &v); e != nil {
		t.Fatalf("JS result: %v %s", e, b)
	}
	return v
}
func TestLocalMaterialWritesRemainReadableAndDuplicateInOriginalJS(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "galaxy-id.json"), []byte(`{"id":"isolated-owner","createdAt":"2026-01-01T00:00:00.000Z"}`), 0600); e != nil {
		t.Fatal(e)
	}
	s, e := NewStore(dir, "")
	if e != nil {
		t.Fatal(e)
	}
	seed := materialJS(t, dir, `const observed=await h.observe({host:'opencode',sessionId:'s',sourceId:'m',kind:'message',source:{kind:'host-event',messageId:'m'},content:{excerpt:'original',originalLength:8,retained:'full',availableFromHost:true},details:{z:1,a:2}});await a.configure({enabled:true,sessions:[{host:'opencode',sessionId:'s'}]});const captured=await a.captureMessage({host:'opencode',sessionId:'s',messageId:'m',message:{id:'m',role:'user',time:{created:1790000000000}},parts:[{type:'text',text:'original'}]});console.log(JSON.stringify({observed,captured}));`)
	work := seed["observed"].(map[string]any)["workId"].(string)
	session := seed["captured"].(map[string]any)["archiveSessionId"].(string)
	length := int64(8)
	observation := WorkObservationInput{Host: "opencode", SessionID: "s", SourceID: "m", Kind: "message", Source: WorkSource{Kind: "host-event", MessageID: "m"}, Content: &WorkContent{Excerpt: "original", OriginalLength: &length, Retained: "full", AvailableFromHost: true}, Details: json.RawMessage(`{"z":1,"a":2}`)}
	observed, e := s.ObserveWork(ctx, observation)
	if e != nil {
		t.Fatal(e)
	}
	if observed.(map[string]any)["duplicate"] != true {
		t.Fatalf("existing JS observation changed: %s", mustJSON(observed))
	}
	capture := ArchiveCaptureInput{Host: "opencode", SessionID: "s", MessageID: "m", Message: json.RawMessage(`{"id":"m","role":"user","time":{"created":1790000000000}}`), Parts: json.RawMessage(`[{"type":"text","text":"original"}]`)}
	captured, e := s.CaptureArchiveMessage(ctx, capture)
	if e != nil {
		t.Fatal(e)
	}
	if captured.(map[string]any)["duplicate"] != true {
		t.Fatalf("existing JS original changed: %s", mustJSON(captured))
	}
	observation.Content.Excerpt = "password=fake-only-for-test"
	observation.Content.Retained = "full"
	observation.SourceID = "m2"
	observed, e = s.ObserveWork(ctx, observation)
	if e != nil {
		t.Fatal(e)
	}
	ob := observed.(map[string]any)["observation"].(map[string]any)
	if ob["content"].(map[string]any)["retained"] != "excerpt" {
		t.Fatal("redacted full claim retained")
	}
	// A late source revision remains historical and cannot replace the current host title.
	newRevision := int64(3)
	title := WorkObservationInput{Host: "opencode", SessionID: "s", SourceID: "session-title", Revision: &newRevision, Kind: "session", Title: "Current title", Source: WorkSource{Kind: "host-event"}, Details: json.RawMessage(`{"event":"session-title"}`)}
	if _, e = s.ObserveWork(ctx, title); e != nil {
		t.Fatal(e)
	}
	lateRevision := int64(1)
	title.Revision = &lateRevision
	title.Title = "Historical title"
	title.Details = json.RawMessage(`{"event":"session-title","title":"Historical title"}`)
	late, e := s.ObserveWork(ctx, title)
	if e != nil {
		t.Fatal(e)
	}
	if late.(map[string]any)["late"] != true {
		t.Fatal("late revision lost")
	}
	title.Title = "Conflicting title"
	title.Details = json.RawMessage(`{"event":"session-title","changed":true}`)
	if _, e = s.ObserveWork(ctx, title); fault.Code(e) != "local_work_source_revision_conflict" {
		t.Fatalf("revision conflict missing: %v", e)
	}
	environment, e := s.ObserveWorkEnvironment(ctx, WorkEnvironmentInput{Host: "opencode", SessionID: "s", Facts: json.RawMessage(`{"host":"opencode","configuredModel":"test/model","tools":["z","a","z"],"env":{"FAKE":"fake"},"unknown":"excluded from facts"}`)})
	if e != nil {
		t.Fatal(e)
	}
	if len(environment.(map[string]any)["exclusions"].([]localdata.Exclusion)) != 1 {
		t.Fatal("environment credential exclusion missing")
	}
	pending, e := s.WorkPending(ctx, WorkQuery{WorkID: work})
	if e != nil {
		t.Fatal(e)
	}
	p := pending.(map[string]any)
	sources := []string{}
	for _, v := range p["observations"].([]any) {
		sources = append(sources, v.(map[string]any)["id"].(string))
	}
	through := integer(p["throughSequence"])
	if _, e = s.SubmitWorkSummary(ctx, WorkSummaryInput{WorkID: work, ThroughSequence: through, SourceObservationIDs: []string{sources[0]}, Title: "Invalid incomplete", Summary: "not persisted"}); fault.Code(e) != "local_work_summary_sources_invalid" {
		t.Fatalf("incomplete sources accepted: %v", e)
	}
	_, e = s.SubmitWorkSummary(ctx, WorkSummaryInput{WorkID: work, ThroughSequence: through, SourceObservationIDs: sources, Title: "Summary", Summary: "Observed result", Outcome: "unknown", Execution: &WorkExecution{Host: "opencode", SessionID: "summary-helper"}})
	if e != nil {
		t.Fatal(e)
	}
	capture.Parts = json.RawMessage(`[{"type":"text","text":"password=fake-only-for-test"}]`)
	if _, e = s.CaptureArchiveMessage(ctx, capture); e != nil {
		t.Fatal(e)
	}
	expected := materialJS(t, dir, `const list=await h.list();const w=await h.exportWork({workId:list.items[0].workId});const sessions=await a.list();const archive=await a.exportSession({archiveSessionId:sessions.items[0].archiveSessionId});const duplicate=await a.captureMessage({host:'opencode',sessionId:'s',messageId:'m',message:{id:'m',role:'user',time:{created:1790000000000}},parts:[{type:'text',text:'password=fake-only-for-test'}]});console.log(JSON.stringify({work:w,archive,duplicate}));`)
	if expected["duplicate"].(map[string]any)["duplicate"] != true {
		t.Fatal("original JS did not deduplicate Go original")
	}
	exported, e := s.WorkExport(ctx, WorkQuery{WorkID: work})
	if e != nil {
		t.Fatal(e)
	}
	exported.(map[string]any)["exportedAt"] = expected["work"].(map[string]any)["exportedAt"]
	same(t, expected["work"], exported)
	archive, e := s.ArchiveExport(ctx, ArchiveQuery{ArchiveSessionID: session})
	if e != nil {
		t.Fatal(e)
	}
	same(t, expected["archive"], archive)
	if _, e = s.SubmitWorkSummary(ctx, WorkSummaryInput{WorkID: work, ThroughSequence: through, SourceObservationIDs: sources, Title: "Summary", Summary: "retry"}); fault.Code(e) != "local_work_summary_revision_conflict" {
		t.Fatalf("summary stale revision: %v", e)
	}
	_, e = s.CaptureArchiveMessage(ctx, ArchiveCaptureInput{GalaxyID: "other-owner", Host: "opencode", SessionID: "s", MessageID: "m"})
	if fault.Code(e) != "local_archive_identity_changed" {
		t.Fatalf("identity mismatch: %v", e)
	}
	if _, e = s.DeleteWork(ctx, WorkQuery{WorkID: work}); e != nil {
		t.Fatal(e)
	}
	found, e := s.ArchiveDescribe(ctx, ArchiveQuery{ArchiveSessionID: session})
	if e != nil || found == nil {
		t.Fatalf("work deletion affected archive: %v", e)
	}
	if _, e = s.ArchiveDelete(ctx, ArchiveQuery{ArchiveSessionID: session}); e != nil {
		t.Fatal(e)
	}
	settings, e := s.ArchiveSettings(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if settings.(map[string]any)["settings"].(ArchiveSettings).Enabled {
		t.Fatal("archive deletion retained selection")
	}
}
