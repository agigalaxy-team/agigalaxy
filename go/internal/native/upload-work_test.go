package native

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
)

type workUploadFixtureMetadata struct {
	connectionFixtureMetadata
	OperationID  string              `json:"operationId"`
	UnknownID    string              `json:"unknownId"`
	WorkID       string              `json:"workId"`
	TargetID     string              `json:"targetId"`
	DataJSON     string              `json:"dataJson"`
	Settings     map[string]any      `json:"settings"`
	PeerDeviceID string              `json:"peerDeviceId"`
	Authorize    func(string) string `json:"-"`
}

func TestWorkUploadOriginalPreparedLostACKReconcilesWithoutResend(t *testing.T) {
	store, meta, transport := nativeGoUploadFixture(t)
	ctx := context.Background()
	rt, e := NewRuntime(store, meta.Configuration, ConnectionOptions{HTTPClient: &http.Client{Transport: transport}, Now: func() time.Time { return time.Unix(meta.Now, 0) }})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	upload := NewWorkUpload(rt)
	settings, e := upload.Settings(ctx)
	if e != nil {
		t.Fatal(e)
	}
	choice := uploadObject(uploadObject(settings)["choice"])
	ids, ok := connectionStrings(choice["workIds"])
	if !ok || choice["enabled"] != true || choice["targetAccountId"] != meta.TargetID || len(ids) != 1 || ids[0] != meta.WorkID || len(uploadRows(uploadObject(settings)["queue"])) != 1 {
		t.Fatal("reviewed upload scope or prepared operation changed", settings)
	}
	drop := true
	puts := 0
	transport.setHook(func(response *http.Response, req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/v2/account-work/put" {
			puts++
			if drop {
				drop = false
				response.Body.Close()
				return nil, io.ErrUnexpectedEOF
			}
		}
		return response, nil
	})
	result, e := upload.Resume(ctx, meta.OperationID)
	if e != nil {
		t.Fatal(e)
	}
	if result.(map[string]any)["state"] != "unknown" || puts != 1 {
		t.Fatalf("lost ACK not retained: %v", result)
	}
	result, e = upload.Resume(ctx, meta.OperationID)
	if e != nil {
		t.Fatal(e)
	}
	if result.(map[string]any)["state"] != "stored" || puts != 1 {
		t.Fatalf("original receipt replayed PUT: %v", result)
	}
	stored, e := rt.Call(ctx, "/v2/account-work/get", map[string]any{"workId": meta.WorkID}, ConnectionCallOptions{AccountID: meta.TargetID})
	if e != nil {
		t.Fatal(e)
	}
	var expectedData any
	json.Unmarshal([]byte(meta.DataJSON), &expectedData)
	same(t, expectedData, stored["data"])
	if stored["lastOperationId"] != meta.OperationID || stored["audience"] != "owner-only" || stored["completeConversation"] != false {
		t.Fatal("work upload changed origin or coverage")
	}
	before := puts
	currentScope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if e = upload.queue(ctx, true, currentScope.Owner, &currentScope, func(db *sql.DB, owner string) error {
		_, e := db.ExecContext(ctx, "INSERT INTO work_sync_jobs(id,owner_id,endpoint,target_id,work_id,choice_id,scope_id,source_token,data_json,state,updated_at,expected_revision,revision) SELECT ?,owner_id,endpoint,target_id,work_id,choice_id,scope_id,'older-unknown-token',data_json,'unknown',updated_at,0,1 FROM work_sync_jobs WHERE id=?", meta.UnknownID, meta.OperationID)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	unresolved, e := upload.Resume(ctx, meta.UnknownID)
	if e != nil {
		t.Fatal(e)
	}
	if unresolved.(map[string]any)["state"] != "unknown" || unresolved.(map[string]any)["reconciliationRequired"] != true || puts != before {
		t.Fatal("older unknown operation was automatically POSTed")
	}
	currentScope, e = store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = upload.ChooseReviewed(ctx, WorkUploadChoice{ChoiceID: uuid.NewString(), Enabled: true, TargetAccountID: meta.TargetID, WorkIDs: []string{meta.WorkID}, IncludeExisting: true, RestoreWorkIDs: []string{meta.WorkID}}, &currentScope); e != nil {
		t.Fatal(e)
	}
	prepared, e := upload.Prepare(ctx, meta.WorkID)
	if e != nil {
		t.Fatal(e)
	}
	nextOperation := prepared.(map[string]any)["operationId"].(string)
	if nextOperation == meta.OperationID || nextOperation == meta.UnknownID {
		t.Fatal("new explicit source choice reused an unknown operation")
	}
	fresh, e := upload.Resume(ctx, nextOperation)
	if e != nil || fresh.(map[string]any)["state"] != "stored" {
		t.Fatalf("Go projection/queue/put path: %v %v", e, fresh)
	}
	if puts != before+1 {
		t.Fatal("Go prepared source sent more than once")
	}
	head, e := rt.Call(ctx, "/v2/account-work/get", map[string]any{"workId": meta.WorkID}, ConnectionCallOptions{AccountID: meta.TargetID})
	if e != nil {
		t.Fatal(e)
	}
	same(t, expectedData, head["data"])
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	stale := scope
	stale.Owner = "another-owner"
	start := transport.count()
	if _, e = rt.Call(ctx, "/v2/account-work/put", map[string]any{}, ConnectionCallOptions{AccountID: meta.TargetID, ExpectedScope: &stale}); fault.Code(e) != "native_connection_selection_changed" || transport.count() != start {
		t.Fatalf("pinned upload adopted a different owner: %v", e)
	}
}
func TestWorkUploadConfirmedReceiptCannotBeDowngraded(t *testing.T) {
	ctx := context.Background()
	store := materialStore(t)
	rt, e := NewRuntime(store, Configuration{Version: 2, Endpoint: store.Endpoint, Website: "https://website.invalid", DataDirectory: store.Directory, TrustedKeys: map[string]Pin{"fixture": {}}}, ConnectionOptions{})
	if e != nil {
		t.Fatal(e)
	}
	defer rt.Close()
	upload := NewWorkUpload(rt)
	scope, e := store.ChoiceScope(ctx)
	if e != nil {
		t.Fatal(e)
	}
	id := uuid.NewString()
	var job map[string]any
	if e = upload.access(ctx, true, true, scope.Owner, &scope, func(db *sql.DB, owner string) error {
		if _, e := db.ExecContext(ctx, "INSERT INTO work_sync_jobs(id,owner_id,endpoint,target_id,work_id,choice_id,scope_id,source_token,data_json,state,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,'stored',?,1)", id, owner, store.Endpoint, uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), "original-token", "{}", localNow()); e != nil {
			return e
		}
		var e error
		job, e = oneMap(ctx, db, "SELECT * FROM work_sync_jobs WHERE id=?", id)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	view, e := upload.mark(ctx, job, &scope, "unknown", "late_transport_failure")
	if e != nil || view["state"] != "stored" || view["error"] != nil {
		t.Fatalf("late error downgraded confirmed receipt: %v %v", e, view)
	}
}
