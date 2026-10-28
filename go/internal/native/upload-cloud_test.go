package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountarchive"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"sync/atomic"
	"testing"
	"time"
)

type uploadDeleteDispatchGate struct {
	next    http.RoundTripper
	blocked atomic.Bool
}

func (g *uploadDeleteDispatchGate) RoundTrip(req *http.Request) (*http.Response, error) {
	if g.blocked.Load() && req.URL.Path == "/v2/account-work/delete" {
		return nil, io.ErrUnexpectedEOF
	}
	return g.next.RoundTrip(req)
}

func TestUploadCloudGoServicesAndRecoveryLifecycle(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := workUploadServiceFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	owner, e := store.Owner(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var issuer, clientID string
	if e = pool.QueryRow(ctx, "SELECT issuer,client_id FROM external_identity_links WHERE subject_id=$1 LIMIT 1", owner).Scan(&issuer, &clientID); e != nil {
		t.Fatal(e)
	}
	profiles := &accounts.Service{Endpoint: meta.Configuration.Endpoint, Now: now}
	registry := &accountlinks.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Accounts: profiles, Providers: []accountlinks.Provider{{Issuer: issuer, ClientID: clientID}}, Now: now}
	service := &accountarchive.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now, Devices: devices, Registry: registry, Profiles: profiles}
	original, _ := url.Parse(meta.Origin)
	server := httptest.NewServer(accountarchive.Handler{Service: service, Devices: devices, Next: httputil.NewSingleHostReverseProxy(original)})
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	gate := &uploadDeleteDispatchGate{next: transport}
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: gate}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	work, archive := NewWorkUpload(rt), NewArchiveUpload(rt)

	// A stopped recovery wait must not proceed to PUT or retain a timer.
	entered := make(chan struct{}, 1)
	var puts atomic.Int32
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/account-work/put" {
			puts.Add(1)
		}
		if req.URL.Path == "/v2/account-work/status" {
			select {
			case entered <- struct{}{}:
			default:
			}
			<-req.Context().Done()
			response.Body.Close()
			return nil, req.Context().Err()
		}
		return response, nil
	})
	rt.ResumePrivateSync(0)
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("recovery did not reach original status")
	}
	rt.privateSync.mu.Lock()
	done := rt.privateSync.done
	rt.privateSync.mu.Unlock()
	rt.privateSync.Pause()
	if done != nil {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("pause did not cancel original status")
		}
	}
	if puts.Load() != 0 {
		t.Fatal("paused recovery dispatched work")
	}
	rt.privateSync.mu.Lock()
	timer := rt.privateSync.timer
	rt.privateSync.mu.Unlock()
	if timer != nil {
		t.Fatal("pause kept recovery timer")
	}
	transport.setHook(nil)
	// An unrelated host event cannot expand the saved source selection.
	start := transport.count()
	if _, e = rt.PrivateSessionComplete(ctx, "opencode", "unselected-session"); e != nil {
		t.Fatal(e)
	}
	if transport.count() != start {
		t.Fatal("unrelated host session sent material")
	}
	result, e := rt.PrivateSessionComplete(ctx, "opencode", "opaque-session")
	if e != nil {
		t.Fatal(e)
	}
	if uploadObject(result)["state"] != "processed" {
		t.Fatalf("host completion: %v", result)
	}
	current, e := work.GetCloud(ctx, UploadCloudQuery{TargetAccountID: meta.TargetID, WorkID: meta.WorkID})
	if e != nil || uploadObject(current)["state"] != "stored" {
		t.Fatalf("Go work upload: %v %v", e, current)
	}
	listed, e := work.ListCloud(ctx, UploadCloudQuery{TargetAccountID: meta.TargetID, Limit: 1})
	if e != nil || len(uploadRows(uploadObject(listed)["items"])) != 1 {
		t.Fatalf("work list: %v %v", e, listed)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	var deletes atomic.Int32
	drop := true
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/account-work/delete" {
			deletes.Add(1)
			if drop {
				drop = false
				response.Body.Close()
				return nil, io.ErrUnexpectedEOF
			}
		}
		return response, nil
	})
	q := UploadCloudQuery{TargetAccountID: meta.TargetID, WorkID: meta.WorkID}
	result, e = work.DeleteCloudReviewed(ctx, q, &scope)
	if e != nil || uploadObject(result)["state"] != "unknown" {
		t.Fatalf("lost delete ACK: %v %v", e, result)
	}
	result, e = work.DeleteCloudReviewed(ctx, q, &scope)
	if e != nil || uploadObject(result)["state"] != "deleted" || deletes.Load() != 1 {
		t.Fatalf("delete POST replayed: %v %v count=%d", e, result, deletes.Load())
	}
	if e = work.queue(ctx, false, scope.Owner, &scope, func(db *sql.DB, _ string) error {
		row, e := oneMap(ctx, db, "SELECT data_json FROM work_sync_jobs WHERE id=?", meta.OperationID)
		if e == nil && row["data_json"] != "null" {
			t.Fatal("deleted work material retained")
		}
		return e
	}); e != nil {
		t.Fatal(e)
	}
	// A new explicit restore gets its own scope; a later reviewed deletion can
	// act on that restored copy instead of replaying an older confirmed receipt.
	if _, e = work.ChooseReviewed(ctx, WorkUploadChoice{ChoiceID: uuid.NewString(), Enabled: true, TargetAccountID: meta.TargetID, WorkIDs: []string{meta.WorkID}, IncludeExisting: true, RestoreWorkIDs: []string{meta.WorkID}}, &scope); e != nil {
		t.Fatal(e)
	}
	prepared, e := work.Prepare(ctx, meta.WorkID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = work.Resume(ctx, text(uploadObject(prepared)["operationId"])); e != nil {
		t.Fatal(e)
	}
	result, e = work.DeleteCloudReviewed(ctx, q, &scope)
	if e != nil || uploadObject(result)["state"] != "deleted" || deletes.Load() != 2 {
		t.Fatalf("restored source delete: %v %v", e, result)
	}
	if _, e = work.ChooseReviewed(ctx, WorkUploadChoice{ChoiceID: uuid.NewString(), Enabled: true, TargetAccountID: meta.TargetID, WorkIDs: []string{meta.WorkID}, IncludeExisting: true, RestoreWorkIDs: []string{meta.WorkID}}, &scope); e != nil {
		t.Fatal(e)
	}
	prepared, e = work.Prepare(ctx, meta.WorkID)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = work.Resume(ctx, text(uploadObject(prepared)["operationId"])); e != nil {
		t.Fatal(e)
	}
	gate.blocked.Store(true)
	if result, e = work.DeleteCloudReviewed(ctx, q, &scope); e != nil || uploadObject(result)["state"] != "unknown" {
		t.Fatalf("interrupted dispatch: %v %v", e, result)
	}
	gate.blocked.Store(false)
	if result, e = work.DeleteCloudReviewed(ctx, q, &scope); e != nil || uploadObject(result)["state"] != "unknown" || deletes.Load() != 2 {
		t.Fatalf("stored status caused blind delete retry: %v %v count=%d", e, result, deletes.Load())
	}
	transport.setHook(nil)

	enabled := true
	sessions := []ArchiveSession{{Host: "opencode", SessionID: "opaque-session"}}
	if _, e = store.configureArchive(ctx, ArchiveInput{GalaxyID: scope.Owner, Enabled: &enabled, Sessions: sessions}, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = store.CaptureArchiveMessage(ctx, ArchiveCaptureInput{GalaxyID: scope.Owner, Host: "opencode", SessionID: "opaque-session", MessageID: "cloud-original", Message: json.RawMessage(`{"role":"user"}`), Parts: json.RawMessage(`[{"type":"text","text":"isolated original"}]`)}); e != nil {
		t.Fatal(e)
	}
	if _, e = rt.SaveLocalSettingsReviewed(ctx, NativeLocalSettingsInput{ChoiceID: uuid.NewString(), GalaxyID: &scope.Owner, Level: "conversation-archive", ConversationMode: "cloud", Sessions: sessions, TargetAccountID: &meta.TargetID, RestoreArchiveSessionIDs: []string{}}, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = rt.PrivateSessionComplete(ctx, "opencode", "opaque-session"); e != nil {
		t.Fatal(e)
	}
	archives, e := archive.ListCloud(ctx, UploadCloudQuery{TargetAccountID: meta.TargetID, Limit: 1})
	if e != nil {
		t.Fatal(e)
	}
	rows := uploadRows(uploadObject(archives)["archives"])
	if len(rows) != 1 {
		t.Fatalf("archive list: %v", archives)
	}
	id := text(uploadObject(rows[0])["id"])
	if _, e = rt.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: "local-only"}, &scope); e != nil {
		t.Fatal(e)
	}
	exported, e := archive.ExportCloud(ctx, UploadCloudQuery{TargetAccountID: meta.TargetID, ID: id})
	if e != nil || text(uploadObject(exported)["content"]) == "" {
		t.Fatalf("owner export incorrectly blocked by upload privacy: %v", e)
	}
	cleaned, e := archive.CleanupCloud(ctx, UploadCloudQuery{TargetAccountID: meta.TargetID})
	if e != nil || uploadObject(cleaned)["deleted"] == nil {
		t.Fatalf("existing retention: %v %v", e, cleaned)
	}
	drop = true
	deletes.Store(0)
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/account-archives/delete" {
			deletes.Add(1)
			if drop {
				drop = false
				response.Body.Close()
				return nil, io.ErrUnexpectedEOF
			}
		}
		return response, nil
	})
	aq := UploadCloudQuery{TargetAccountID: meta.TargetID, ID: id}
	if result, e = archive.DeleteCloudReviewed(ctx, aq, &scope); e != nil || uploadObject(result)["state"] != "unknown" {
		t.Fatalf("archive deletion lost ACK: %v %v", e, result)
	}
	if result, e = archive.DeleteCloudReviewed(ctx, aq, &scope); e != nil || uploadObject(result)["deleted"] != true || deletes.Load() != 1 {
		t.Fatalf("archive deletion replayed: %v %v", e, result)
	}
	transport.setHook(nil)
	stale := scope
	stale.Revision++
	start = transport.count()
	if _, e = work.Flush(uploadScopeContext(ctx, stale), meta.WorkID); fault.Code(e) != "native_connection_selection_changed" || transport.count() != start {
		t.Fatalf("scope changed during flush: %v", e)
	}
	// Closing a live recovery cancels its original request and joins the loop.
	if _, e = rt.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: "history-overview"}, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = store.RecordWorkNote(ctx, WorkNoteInput{GalaxyID: scope.Owner, Host: "opencode", SessionID: "opaque-session", Text: "isolated update before cancellation"}); e != nil {
		t.Fatal(e)
	}
	cancelled := make(chan struct{})
	release := make(chan struct{})
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/account-work/status" {
			select {
			case entered <- struct{}{}:
			default:
			}
			<-req.Context().Done()
			close(cancelled)
			<-release
			response.Body.Close()
			return nil, req.Context().Err()
		}
		return response, nil
	})
	sessionDone := make(chan struct{})
	go func() { _, _ = rt.PrivateSessionComplete(ctx, "opencode", "opaque-session"); close(sessionDone) }()
	select {
	case <-entered:
	case <-time.After(10 * time.Second):
		t.Fatal("close check did not enter original status")
	}
	closed := make(chan struct{})
	go func() { rt.Close(); close(closed) }()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("close did not cancel host completion request")
	}
	select {
	case <-closed:
		t.Fatal("close returned before host completion drained")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case <-closed:
	case <-time.After(5 * time.Second):
		t.Fatal("close did not cancel/join recovery")
	}
	<-sessionDone
	start = transport.count()
	rt.ResumePrivateSync(0)
	if _, e = rt.PrivateSessionComplete(ctx, "opencode", "opaque-session"); fault.Code(e) != "native_runtime_closed" || transport.count() != start {
		t.Fatalf("closed runtime resumed upload: %v", e)
	}
}
