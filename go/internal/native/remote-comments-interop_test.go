package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accounts"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/publicwrites"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
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

func TestRemoteCommentsGoSignedDiscussionUnknownReceiptAndIndependentGovernance(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixtureDatabase(t, dsn)
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
	links := &accountlinks.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Accounts: profiles, Providers: []accountlinks.Provider{{Issuer: issuer, ClientID: clientID}}, Now: now}
	writes := &publicwrites.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Links: links, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Links: links, Writes: writes, Now: now}
	comments := &taskmaterials.CommentService{Service: tasks}
	governance := &taskmaterials.CommentGovernance{CommentService: comments}
	original, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(original)
	next := taskmaterials.CommentHandler{Service: comments, Next: taskmaterials.CommentGovernanceHandler{Service: governance, Next: taskmaterials.Handler{Task: tasks, Next: fallback}}}
	consents := deviceauth.Handler{Service: devices, Next: next}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/consents" || r.URL.Path == "/v2/consents/receipt" {
			consents.ServeHTTP(w, r)
		} else {
			next.ServeHTTP(w, r)
		}
	}))
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	authorize := func(action, operation string, payload map[string]any) map[string]any {
		t.Helper()
		value, e := runtime.AuthorizeReviewed(ctx, map[string]any{"requestId": uuid.NewString(), "action": action, "objectId": operation, "payloadJson": hostJSONString(payload)}, &scope)
		if e != nil {
			t.Fatal(e)
		}
		return map[string]any{"consentId": value["consentId"], "payloadJson": value["payloadJson"]}
	}
	taskID, taskOperation := uuid.NewString(), uuid.NewString()
	request := map[string]any{"operationId": taskOperation, "taskId": taskID, "caseId": nil, "intent": "proactive-review", "workContext": map[string]any{"goal": "Read the selected question", "currentSituation": "A synthetic bounded question", "attemptRefs": []any{}}, "title": "Original discussion boundary", "summary": "A question is not delivery acceptance", "visibility": "Private", "collaboration": "open-assistance", "enrollmentExpiresAt": meta.Now + 3600}
	if _, e = NewNativeTasks(runtime).Call(ctx, "galaxy_task_v2_create", authorize("assistance.publish", taskOperation, request)); e != nil {
		t.Fatal(e)
	}
	client := NewNativeComments(runtime)
	commentID, commentOperation := uuid.NewString(), uuid.NewString()
	comment := map[string]any{"schemaVersion": 2, "id": commentOperation, "commentId": commentID, "taskId": taskID, "expectedRevision": 0, "body": "Please clarify the exact selected version.", "visibility": "inherit-task", "kind": "create", "replyTo": nil}
	submission := authorize("comment.publish", commentOperation, comment)
	var sends atomic.Int32
	transport.setHook(func(response *http.Response, r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/v2/comments" {
			sends.Add(1)
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	if _, e = client.Call(ctx, "galaxy_comment_submit", submission); e == nil {
		t.Fatal("lost comment ACK reported success")
	}
	transport.setHook(nil)
	receipt, e := client.Call(ctx, "galaxy_comment_receipt", map[string]any{"operationId": commentOperation, "payloadHash": identity.Digest([]byte(text(submission["payloadJson"])))})
	if e != nil || receipt["state"] != "acknowledged" || sends.Load() != 1 {
		t.Fatal(receipt, e, sends.Load())
	}
	if _, e = client.Call(ctx, "galaxy_comment_get", map[string]any{"commentId": commentID}); e != nil {
		t.Fatal(e)
	}
	if _, e = client.Call(ctx, "galaxy_comments_query", map[string]any{"taskId": taskID}); e != nil {
		t.Fatal(e)
	}
	config, e := client.Call(ctx, "galaxy_comment_governance_config", map[string]any{})
	if e != nil || config["configured"] != false || config["guaranteesResponse"] != false || config["canModerate"] != false {
		t.Fatal(config, e)
	}
	reportID := uuid.NewString()
	report := map[string]any{"schemaVersion": 2, "id": reportID, "target": map[string]any{"type": "task-comment", "id": commentID, "revision": 1}, "category": "review-request", "summary": "Record a selected private review request; no punishment implied."}
	reportSubmission := authorize("moderation.publish", reportID, report)
	if _, e = client.Call(ctx, "galaxy_comment_report", reportSubmission); e != nil {
		t.Fatal(e)
	}
	reportReceipt, e := client.Call(ctx, "galaxy_comment_governance_receipt", map[string]any{"operationId": reportID, "payloadHash": identity.Digest([]byte(text(reportSubmission["payloadJson"])))})
	if e != nil || reportReceipt["state"] != "acknowledged" {
		t.Fatal(reportReceipt, e)
	}
	eventID := uuid.NewString()
	event := map[string]any{"schemaVersion": 2, "id": eventID, "reportId": reportID, "expectedVersion": 1, "summary": "Keep the exact originally selected comment revision.", "kind": "supplement"}
	eventSubmission := authorize("moderation.publish", eventID, event)
	eventSubmission["reportId"] = reportID
	if _, e = client.Call(ctx, "galaxy_comment_governance_event", eventSubmission); e != nil {
		t.Fatal(e)
	}
	if _, e = client.Call(ctx, "galaxy_comment_governance_query", map[string]any{"commentId": commentID}); e != nil {
		t.Fatal(e)
	}
	pauseID := uuid.NewString()
	pause := map[string]any{"schemaVersion": 2, "id": pauseID, "reportId": reportID, "expectedVersion": 2, "summary": "This caller cannot supply independent moderation authority.", "kind": "pause", "until": meta.Now + 60, "rule": "must be denied"}
	pauseSubmission := authorize("moderation.publish", pauseID, pause)
	pauseSubmission["reportId"] = reportID
	if _, e = client.Call(ctx, "galaxy_comment_governance_event", pauseSubmission); e == nil {
		t.Fatal("reporter gained moderator authority from signed transport")
	}
	if _, e = runtime.Disconnect(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = client.Call(ctx, "galaxy_comments_query", map[string]any{"taskId": taskID}); e == nil {
		t.Fatal("disabled runtime queried private comments")
	}
}
