package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/projects"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/verificationrecords"
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

func TestRemoteFactsGoTaskCaseEvidenceProjectAndOriginalReceipts(t *testing.T) {
	pool, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store, meta, transport := nativeGoUploadFixtureDatabase(t, dsn)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now}
	vs := &verificationrecords.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Cases: cs, Now: now}
	ts := &taskmaterials.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now}
	ps := &projects.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: devices, Now: now}
	original, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(original)
	next := taskmaterials.Handler{Task: ts, Next: cases.Handler{Service: cs, Devices: devices, Next: verificationrecords.Handler{Service: vs, Devices: devices, Next: projects.Handler{Service: ps, Next: fallback}}}}
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
	if _, e = runtime.SetUploadPrivacyReviewed(ctx, UploadPrivacySelection{Level: "work-content"}, &scope); e != nil {
		t.Fatal(e)
	}
	owner := scope.Owner
	authorize := func(action, object string, payload map[string]any) map[string]any {
		t.Helper()
		result, e := runtime.AuthorizeReviewed(ctx, map[string]any{"requestId": uuid.NewString(), "action": action, "objectId": object, "payloadJson": hostJSONString(payload)}, &scope)
		if e != nil {
			t.Fatal("authorization", action, e)
		}
		return map[string]any{"consentId": result["consentId"], "payloadJson": result["payloadJson"]}
	}
	taskClient, factClient, projectClient := NewNativeTasks(runtime), NewNativeFacts(runtime), NewNativeProjects(runtime)
	taskID, taskOperation := uuid.NewString(), uuid.NewString()
	request := map[string]any{"operationId": taskOperation, "taskId": taskID, "caseId": nil, "intent": "proactive-review", "workContext": map[string]any{"goal": "Review the actual local change", "currentSituation": "Synthetic request; no failure asserted", "attemptRefs": []any{}}, "title": "Native Go consumer", "summary": "A bounded synthetic collaboration request", "visibility": "Private", "collaboration": "open-assistance", "enrollmentExpiresAt": meta.Now + 3600}
	submission := authorize("assistance.publish", taskOperation, request)
	var creates atomic.Int32
	transport.setHook(func(response *http.Response, request *http.Request) (*http.Response, error) {
		if request.URL.Path == "/v2/tasks" {
			creates.Add(1)
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	if _, e = taskClient.Call(ctx, "galaxy_task_v2_create", submission); e == nil {
		t.Fatal("unknown Task commit reported success")
	}
	transport.setHook(nil)
	receipt, e := taskClient.Call(ctx, "galaxy_task_v2_receipt", map[string]any{"taskId": taskID, "eventId": taskOperation, "payloadHash": identity.Digest([]byte(text(submission["payloadJson"])))})
	if e != nil || receipt["state"] != "acknowledged" || creates.Load() != 1 {
		t.Fatal("Task receipt", receipt, e, creates.Load())
	}
	if _, e = taskClient.Call(ctx, "galaxy_task_v2_get", map[string]any{"taskId": taskID}); e != nil {
		t.Fatal(e)
	}
	caseID := uuid.NewString()
	root := map[string]any{"schemaVersion": 2, "eventId": caseID, "caseId": caseID, "expectedVersion": 0, "actorId": owner, "kind": "case-created", "localRef": "native-fixture", "title": "Actual synthetic reports", "summary": "No Attempt or success invented", "source": map[string]any{"kind": "local", "reference": "native-fixture"}, "synthetic": true}
	caseSubmission := authorize("case.teaser.publish", caseID, root)
	if _, e = factClient.Call(ctx, "galaxy_case_v2_submit", caseSubmission); e != nil {
		t.Fatal(e)
	}
	if _, e = factClient.Call(ctx, "galaxy_case_v2_read", map[string]any{"caseId": caseID}); e != nil {
		t.Fatal(e)
	}
	caseReceipt, e := factClient.Call(ctx, "galaxy_case_v2_receipt", map[string]any{"caseId": caseID, "eventId": caseID, "payloadHash": identity.Digest([]byte(text(caseSubmission["payloadJson"])))})
	if e != nil || caseReceipt["state"] != "acknowledged" {
		t.Fatal(caseReceipt, e)
	}
	evidenceID, evidenceOperation := uuid.NewString(), uuid.NewString()
	evidence := map[string]any{"id": evidenceID, "operationId": evidenceOperation, "expectedVersion": 0, "caseId": caseID, "reportedBy": owner, "synthetic": true, "kind": "evidence", "evidenceType": "self-assertion", "source": map[string]any{"originSystem": "native-fixture", "externalStableId": "original", "contentVersion": "1", "originalAt": now().UTC().Format("2006-01-02T15:04:05.000Z"), "issuer": "own statement"}, "observedAt": now().UTC().Format("2006-01-02T15:04:05.000Z"), "reportedSourceState": "unknown", "summary": "Limited own statement, not independent verification"}
	evidenceSubmission := authorize("evidence.submit", evidenceOperation, evidence)
	if _, e = factClient.Call(ctx, "galaxy_evidence_v2_submit", evidenceSubmission); e != nil {
		t.Fatal(e)
	}
	evidenceReceipt, e := factClient.Call(ctx, "galaxy_verification_record_receipt", map[string]any{"type": "evidence", "id": evidenceID, "operationId": evidenceOperation, "payloadHash": identity.Digest([]byte(text(evidenceSubmission["payloadJson"])))})
	if e != nil || evidenceReceipt["state"] != "acknowledged" || evidenceReceipt["currentAccessGranted"] != false || evidenceReceipt["contentReturned"] != false {
		t.Fatal(evidenceReceipt, e)
	}
	projectID, projectOperation := uuid.NewString(), uuid.NewString()
	projectEvent := map[string]any{"operationId": projectOperation, "projectId": projectID, "expectedRevision": 0, "kind": "create", "document": map[string]any{"kind": "project", "title": "Synthetic bounded project", "summary": "Explicit source, no claimed capability", "functions": []any{"review"}, "technologies": []any{}}}
	projectSubmission := authorize("project.write", projectOperation, projectEvent)
	if _, e = projectClient.Call(ctx, "galaxy_project_v2_event", projectSubmission, nil); e != nil {
		t.Fatal(e)
	}
	if _, e = projectClient.Call(ctx, "galaxy_project_v2_get", map[string]any{"projectId": projectID}, nil); e != nil {
		t.Fatal(e)
	}
	preferences, e := projectClient.Call(ctx, "galaxy_project_v2_preferences", map[string]any{"projectId": projectID}, nil)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = projectClient.Call(ctx, "galaxy_project_v2_preferences_save", map[string]any{"projectId": projectID, "expectedRevision": preferences["revision"], "preferences": nil}, &scope); e != nil {
		t.Fatal(e)
	}
	if _, e = runtime.Disconnect(ctx); e != nil {
		t.Fatal(e)
	}
	if _, e = taskClient.Call(ctx, "galaxy_tasks_v2_query", map[string]any{}); e == nil {
		t.Fatal("disabled runtime made Task request")
	}
}
