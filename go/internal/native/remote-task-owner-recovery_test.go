package native

import (
	"context"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNativeRecoveredTaskOwnerReadControlOriginalReceipt(t *testing.T) {
	ctx := context.Background()
	pool, _ := testsupport.PostgreSQL(t)
	store, meta, transport, prepared := connectionServiceFixtureWithPool(t, pool)
	now := func() time.Time { return time.Unix(meta.Now, 0) }
	taskService := &taskmaterials.Service{Pool: pool, Endpoint: meta.Configuration.Endpoint, Devices: prepared.Service, Now: now}
	original, _ := url.Parse(meta.Origin)
	fallback := httputil.NewSingleHostReverseProxy(original)
	server := httptest.NewServer(deviceauth.Handler{Service: prepared.Service, Next: taskmaterials.Handler{Task: taskService, Next: fallback}})
	defer server.Close()
	transport.origin, _ = url.Parse(server.URL)
	runtime, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: now})
	if e != nil {
		t.Fatal(e)
	}
	defer runtime.Close()
	originalSession, e := runtime.Restore(ctx)
	if e != nil {
		t.Fatal(e)
	}
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	task := map[string]any{"operationId": uuid.NewString(), "taskId": uuid.NewString(), "caseId": nil, "intent": "proactive-review", "title": "Retained recovered owner work", "summary": "Exact authored recovery fixture", "workContext": map[string]any{"goal": "Retain original authored bytes", "currentSituation": "Recover same controlled ID", "attemptRefs": []any{}}, "visibility": "Private", "collaboration": "open-assistance", "enrollmentExpiresAt": meta.Now + 10000}
	sign := func(action, id, payload string, expiry int64) map[string]any {
		t.Helper()
		s, e := store.ChoiceScope(ctx)
		if e != nil {
			t.Fatal(e)
		}
		v, e := runtime.AuthorizeReviewed(ctx, map[string]any{"requestId": uuid.NewString(), "action": action, "objectId": id, "payloadJson": payload, "visibility": "Private", "viewers": []any{}, "expiresAt": expiry}, &s)
		if e != nil {
			t.Fatal("signed consent", e)
		}
		return map[string]any{"consentId": v["consentId"], "payloadJson": v["payloadJson"]}
	}
	tasks := NewNativeTasks(runtime)
	payload := hostJSONString(task)
	grant := sign("assistance.publish", text(task["operationId"]), payload, meta.Now+7200)
	if _, e = tasks.Call(ctx, "galaxy_task_v2_create", grant); e != nil {
		t.Fatal("create original task", e)
	}
	recovery := NewNativeRecovery(runtime)
	pending, e := recovery.PrepareSet(ctx, &scope)
	if e != nil {
		t.Fatal(e)
	}
	code, e := recovery.codeForLocalDisplay(ctx, text(pending["operationId"]))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = recovery.ConfirmSet(ctx, text(pending["operationId"]), &scope); e != nil {
		t.Fatal(e)
	}
	recovered, e := recovery.RecoverReviewed(ctx, code, &scope)
	if e != nil {
		t.Fatal("recover", e)
	}
	newScope, e := store.ChoiceScope(ctx)
	if e != nil || newScope.Owner != originalSession.SubjectID || newScope.DeviceID == scope.DeviceID {
		t.Fatal("identity continuity", newScope, e)
	}
	if _, e = recovery.ConfirmNextSaved(ctx, text(recovered["operationId"]), &newScope); e != nil {
		t.Fatal("save next recovery", e)
	}
	plan, e := runtime.PrepareConnect(ctx)
	if e != nil {
		t.Fatal("prepare recovered connection", e)
	}
	if _, e = runtime.ConnectReviewed(ctx, plan, &newScope); e != nil {
		t.Fatal("connect recovered identity", e)
	}
	id := text(task["taskId"])
	readID := uuid.NewString()
	preview, e := tasks.Call(ctx, "galaxy_task_v2_owner_read_prepare", map[string]any{"taskId": id, "operationId": readID})
	if e != nil {
		t.Fatal("owner read preview", e)
	}
	readGrant := sign("task.owner-read", readID, text(preview["payloadJson"]), integer(preview["expiresAt"]))
	readGrant["taskId"] = id
	read, e := tasks.Call(ctx, "galaxy_task_v2_owner_read", readGrant)
	if e != nil {
		t.Fatal("owner read", e)
	}
	if !strings.Contains(hostJSONString(read), "Retained recovered owner work") {
		t.Fatal("owner read did not return original authored Task bytes")
	}
	if read["currentAccessGranted"] == true || read["completeTaskAccessGranted"] == true {
		t.Fatal("owner read broadened access", read)
	}
	if _, e = tasks.Call(ctx, "galaxy_task_v2_get", map[string]any{"taskId": id}); fault.Status(e) != 403 {
		t.Fatal("ordinary read obtained recovery permission", e)
	}
	operation := uuid.NewString()
	controlPreview, e := tasks.Call(ctx, "galaxy_task_v2_owner_control_prepare", map[string]any{"taskId": id, "operationId": operation, "kind": "stop-enrollment", "reason": "Recovered owner stops new enrollment"})
	if e != nil {
		t.Fatal("control preview", e)
	}
	control := sign("assistance.publish", operation, text(controlPreview["payloadJson"]), integer(controlPreview["expiresAt"]))
	control["taskId"] = id
	var posts atomic.Int32
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/tasks/"+id+"/owner-control" {
			posts.Add(1)
			response.Body.Close()
			return nil, io.ErrUnexpectedEOF
		}
		return response, nil
	})
	if _, e = tasks.Call(ctx, "galaxy_task_v2_owner_control", control); e == nil || posts.Load() != 1 {
		t.Fatal("lost ACK", e, posts.Load())
	}
	transport.setHook(nil)
	receipt, e := tasks.Call(ctx, "galaxy_task_v2_owner_control", control)
	if e != nil || receipt["state"] != "enrollment-stopped" || receipt["currentAccessGranted"] != false || receipt["materialAccessChanged"] != false {
		t.Fatal("original control receipt", receipt, e)
	}
	if _, e = tasks.Call(ctx, "galaxy_task_v2_get", map[string]any{"taskId": id}); fault.Status(e) != 403 {
		t.Fatal("control broadened normal read", e)
	}
}
