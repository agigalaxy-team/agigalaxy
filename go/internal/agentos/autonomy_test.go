package agentos

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

func TestAutonomyTaskTransportUsesOriginalScopeAndNeverReplaysLostPOST(t *testing.T) {
	taskID, planID, accountID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	key, serviceKey := strings.Repeat("j", 32), strings.Repeat("k", 32)
	var writes atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Galaxy-Service-Key") != serviceKey {
			t.Error("missing original service authentication")
		}
		claims, valid := verifyFixtureToken(key, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		issued, _ := index(claims["iat"])
		expires, _ := index(claims["exp"])
		if !valid || claims["sub"] != "autonomy:"+taskID || claims["scope"] != "task" || claims["taskId"] != taskID || claims["planId"] != planID || claims["accountId"] != accountID || claims["delegationVersion"] != nil || expires-issued != 60 {
			t.Error("original task token scope differs")
		}
		if r.Method == "POST" {
			writes.Add(1)
			if r.Header.Get("Idempotency-Key") != taskID || r.Header.Get("Content-Type") != "application/json" {
				t.Error("task operation headers changed")
			}
			if r.URL.Path != "/galaxy/autonomy/tasks/"+taskID+"/runs" {
				t.Error("task endpoint changed")
			}
			var body Object
			if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 0 {
				t.Error("duty body must not self-report an actor")
			}
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = connection.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Object{"state": "RUNNING"})
	}))
	defer server.Close()
	client, err := New(Configuration{URL: server.URL, SigningKey: key, ServiceKey: serviceKey}, Options{Now: func() time.Time { return time.Unix(2000000000, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err = client.AutonomyRequest(ctx, taskID, planID, accountID, nil, "", false); err != nil {
		t.Fatal(err)
	}
	if _, err = client.AutonomyRequest(ctx, taskID, planID, accountID, nil, "/runs", true); fault.Code(err) != "operations_autonomy_result_unknown" || writes.Load() != 1 {
		t.Fatal("lost task response replayed", writes.Load(), err)
	}
	value, err := client.AutonomyRequest(ctx, taskID, planID, accountID, nil, "", false)
	if err != nil || value["state"] != "RUNNING" || writes.Load() != 1 {
		t.Fatal("original task read did not remain a read", value, err)
	}
	if _, err = client.AutonomyRequest(ctx, taskID, planID, accountID, nil, "/../foreign", true); fault.Code(err) != "invalid_operations_autonomy_request" || writes.Load() != 1 {
		t.Fatal("uncontrolled task endpoint accepted", err)
	}
}
