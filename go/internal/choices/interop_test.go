package choices

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOwnerChoiceSourcesAndReceipt(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, err := databaseschema.Migrate(ctx, owner, []string{"api", "worker"}); err != nil {
		t.Fatal(err)
	}
	endpoint := "https://choice.example.invalid"
	identity := deviceauthfixture.NewEndpoint(t, owner, t.TempDir(), []string{"binding", "consent", "assistance", "history"}, endpoint)
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(2000000000, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: endpoint, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Now: now, CaseOwnerSource: cs.RequireOwnerSourceWithin}
	history := &historyv2.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Tasks: tasks.ReadHistoryWireWithin, Now: now}
	task := Object{"operationId": uuid.NewString(), "taskId": uuid.NewString(), "caseId": nil, "intent": "collaboration", "title": "Current task eligibility", "summary": "Explicit selected work", "workContext": Object{"goal": "Original goal", "currentSituation": "Original current situation", "attemptRefs": []any{}}, "visibility": "Private", "collaboration": "open-assistance", "capabilityId": "code", "enrollmentExpiresAt": now().Unix() + 3600}
	grant := identity.Grant(t, task, "assistance.publish", task["operationId"].(string), "Private", nil)
	if _, e = tasks.CreateTask(ctx, taskmaterials.Actor{Actor: identity.Actor}, taskmaterials.TaskSubmission{ConsentID: grant["consentId"].(string), PayloadJSON: grant["payloadJson"].(string)}); e != nil {
		t.Fatal("current task creation", e)
	}
	reader := &Reader{Tasks: tasks, History: history}
	svc := &Service{Pool: pool, Endpoint: endpoint, Devices: devices, Sources: reader, Now: now}
	handler := Handler{Service: svc}
	search := &searchv2.Service{Pool: pool, Devices: devices, History: history, Now: now, Tasks: func(ctx context.Context, a *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
		if a == nil {
			return tasks.QueryTasksWire(ctx, nil, "requested", "", "", 20)
		}
		actor := taskmaterials.Actor{Actor: *a}
		return tasks.QueryTasksWire(ctx, &actor, "requested", "", "", 20)
	}}
	ref := func(kind string, query Object) Object {
		t.Helper()
		input, _ := json.Marshal(Object{"type": kind, "query": query})
		page, e := search.Query(ctx, &identity.Actor, input)
		if e != nil {
			t.Fatal("current source search", kind, e)
		}
		b, _ := json.Marshal(page)
		var out Object
		if e = json.Unmarshal(b, &out); e != nil {
			t.Fatal(e)
		}
		for _, v := range array(out["items"]) {
			item := object(v)
			if item["id"] == task["taskId"] {
				return object(item["ref"])
			}
		}
		t.Fatalf("selected task absent from %s search", kind)
		return nil
	}
	taskQuery := Object{"view": "requested"}
	historyQuery := Object{"subjectId": identity.Actor.SubjectID}
	taskRef := ref("task", taskQuery)
	historyRef := ref("history", historyQuery)
	snapshot := uuid.NewString()
	candidate := []any{Object{"type": "task", "id": taskRef["id"], "version": taskRef["version"]}, Object{"type": "history", "id": historyRef["id"], "version": historyRef["version"]}}
	witnesses := []any{Object{"search": Object{"type": "task", "query": taskQuery}, "ref": taskRef}, Object{"search": Object{"type": "history", "query": historyQuery}, "ref": historyRef}}
	base := Object{"snapshotId": snapshot, "versionId": uuid.NewString(), "baseRevision": 0, "preferenceRevision": 1, "content": Object{"localVersion": 1, "localTaskRef": "local-explicit-choice", "visibleRationale": "Owner retained selected-source rationale", "rationaleAuthor": "user", "candidateRefs": candidate, "selectedRefs": []any{candidate[0]}, "resultRefs": []any{}}, "witnesses": witnesses}
	conflict := Object{}
	for k, v := range base {
		conflict[k] = v
	}
	conflict["versionId"] = uuid.NewString()
	content := Object{}
	for k, v := range object(base["content"]) {
		content[k] = v
	}
	content["localVersion"], content["visibleRationale"] = 2, "Alternative retained by another device"
	conflict["content"] = content
	resolve := Object{}
	for k, v := range base {
		resolve[k] = v
	}
	resolve["versionId"], resolve["baseRevision"], resolve["resolveVersionIds"] = uuid.NewString(), 1, []any{conflict["versionId"]}
	resolvedContent := Object{}
	for k, v := range object(base["content"]) {
		resolvedContent[k] = v
	}
	resolvedContent["localVersion"] = 3
	resolve["content"] = resolvedContent
	request := func(action string, input Object, status int) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/v2/choice-snapshots/"+action, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+identity.Credential)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s HTTP%d %s", action, w.Code, w.Body.String())
		}
		var out Object
		if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	request("preferences/read", Object{}, 200)
	request("preferences/save", Object{"endpoint": endpoint, "expectedRevision": 0, "enabled": true, "snapshotIds": []any{snapshot}}, 200)
	receipts := []Object{}
	for i, put := range []Object{base, conflict, resolve} {
		parsed, e := Parse("put", put)
		if e != nil {
			t.Fatal(e)
		}
		hash, e := digestIntent(PutIntent(parsed))
		if e != nil {
			t.Fatal(e)
		}
		receipt := Object{"snapshotId": snapshot, "versionId": put["versionId"], "requestHash": hash}
		receipts = append(receipts, receipt)
		first := request("put", put, 200)
		if first["syncState"] != []string{"synced", "conflict", "synced"}[i] {
			t.Fatal("unexpected conflict or resolution", first)
		}
		replay := request("put", put, 200)
		if replay["replayed"] != true || replay["operationVersionId"] != put["versionId"] {
			t.Fatal("missing exact operation replay", replay)
		}
		if got := request("receipt", receipt, 200); got["state"] != "acknowledged" {
			t.Fatal("accepted receipt missing", got)
		}
	}
	request("list", Object{}, 200)
	if _, e = identity.Service.RevokeConsent(ctx, identity.Actor, grant["consentId"].(string), nil); e != nil {
		t.Fatal(e)
	}
	current := request("get", Object{"snapshotId": snapshot}, 200)
	if object(object(current["current"])["content"])["visibleRationale"] != nil || object(object(current["current"])["content"])["rationaleUnavailable"] != true {
		t.Fatal("revoked source retained rationale", current)
	}
	receipt := receipts[0]
	request("receipt", receipt, 200)
	request("delete", Object{"snapshotId": snapshot, "expectedRevision": 2}, 200)
	request("get", Object{"snapshotId": snapshot}, 200)
	request("receipt", receipt, 200)
	wrong := Object{"snapshotId": snapshot, "versionId": receipt["versionId"], "requestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	if request("receipt", wrong, 200)["state"] != "conflict" {
		t.Fatal("mismatched accepted intent")
	}
}
