package qualification

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/notifications"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/searchv2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
)

func TestOriginalCurrentSelectedEligibility(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/qualification-interop.mjs"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_QUALIFICATION_DIR="+dir)
	stdout, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	stdin, e := cmd.StdinPipe()
	if e != nil {
		t.Fatal(e)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() {
		_, _ = io.WriteString(stdin, "stop\n")
		_ = stdin.Close()
		if e := cmd.Wait(); e != nil && ctx.Err() == nil {
			t.Errorf("original fixture: %v %s", e, stderr.String())
		}
	}()
	scanner := bufio.NewScanner(stdout)
	ready := false
	for scanner.Scan() {
		if scanner.Text() == "ready" {
			ready = true
			break
		}
	}
	if !ready {
		t.Fatalf("original fixture: %s", stderr.String())
	}
	var f struct {
		Endpoint, Token, Bridge           string
		AuthorToken                       string
		LegacyID                          string
		Now                               int64
		Policy, Query, V2Query, OpenQuery Object
		CalculationQuery                  Object
		CalculationCommands               []struct {
			Author  bool
			Input   Envelope
			Receipt Object
		}
		RevokeCalculation struct {
			Author  bool
			Input   Envelope
			Receipt Object
		}
		PlanQuery       Object
		RequestID       string
		RequestCommands []struct {
			Author  bool
			Input   Envelope
			Receipt Object
		}
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "fixture.json"))
	if e = json.Unmarshal(raw, &f); e != nil {
		t.Fatal(e)
	}
	pool, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_api")
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	now := func() time.Time { return time.Unix(f.Now, 0) }
	devices := &deviceauth.Service{Pool: pool, Endpoint: f.Endpoint, Now: now}
	cs := &cases.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now, CaseOwnerSource: cs.RequireOwnerSourceWithin}
	s, e := New(pool, f.Endpoint, devices, []Object{f.Policy}, now)
	if e != nil {
		t.Fatal(e)
	}
	s.Assistance = tasks
	s.Proofs = &evidence.ProofService{}
	s.Cases = cs
	inbox := &notifications.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	inbox.Readers = notifications.CurrentReaders{Task: tasks.NotificationReadWithin, Assistance: tasks.LegacyNotificationReadWithin, Qualification: s.NotificationReadWithin}
	s.IsBlockedWithin = inbox.IsBlockedWithin
	handler := Handler{Service: s, Next: notifications.Handler{Service: inbox, Next: taskmaterials.Handler{Task: tasks}}}
	requestToken := f.Token
	request := func(path string, input any) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+requestToken)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("qualification HTTP %s: status %d %s", path, w.Code, w.Body.String())
		}
		var out Object
		if e = json.Unmarshal(w.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	original := func(action string, query Object) Object {
		t.Helper()
		raw, _ := json.Marshal(Object{"action": action, "query": query})
		r, _ := http.NewRequestWithContext(ctx, "POST", f.Bridge, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		res, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var out Object
		if e = json.NewDecoder(res.Body).Decode(&out); e != nil {
			t.Fatal(e)
		}
		if res.StatusCode != 200 {
			t.Fatalf("original qualification: status %d %v", res.StatusCode, out)
		}
		return out
	}
	equal := func(actual, expected Object) {
		t.Helper()
		a, _ := json.Marshal(actual)
		var normalized Object
		if e := json.Unmarshal(a, &normalized); e != nil {
			t.Fatal(e)
		}
		a, _ = json.Marshal(normalized)
		b, _ := json.Marshal(expected)
		if string(a) != string(b) {
			t.Fatalf("current original eligibility differs Go=%s original=%s", a, b)
		}
	}
	equal(request("/v1/qualification/policies", Object{}), original("list", nil))
	search := &searchv2.Service{Pool: pool, Devices: devices, Now: now, Tasks: func(ctx context.Context, a *deviceauth.Actor, raw []byte) (json.RawMessage, error) {
		var q Object
		if e := json.Unmarshal(raw, &q); e != nil {
			return nil, e
		}
		var actor *taskmaterials.Actor
		if a != nil {
			actor = &taskmaterials.Actor{Actor: *a}
		}
		return tasks.QueryTasksWire(ctx, actor, str(q, "view"), str(q, "query"), str(q, "after"), int(number(q["limit"])))
	}}
	searchActor, e := devices.Authenticate(ctx, f.Token, "assistance")
	if e != nil {
		t.Fatal(e)
	}
	searchView, e := search.Query(ctx, &searchActor, []byte(`{"type":"task","query":{"view":"requested"}}`))
	if e != nil {
		t.Fatal(e)
	}
	equal(searchView, original("search-tasks", Object{}))
	view := request("/v1/qualification/evaluate", f.Query)
	equal(view, original("evaluate", f.Query))
	if view["eligible"] != true || len(array(view["acceptedCollaborations"])) != 1 {
		t.Fatal("real accepted collaboration was not evaluated")
	}
	q := cloneValue(f.Query).(Object)
	q["evidence"] = Object{"proofIds": []any{uuid.NewString()}, "assistanceIds": object(f.Query["evidence"])["assistanceIds"]}
	equal(request("/v1/qualification/evaluate", q), original("evaluate", q))
	equal(request("/v1/requester-history/query", Object{}), original("requester-history", Object{}))
	factQuery := Object{"assistanceId": f.LegacyID, "limit": 2}
	factPage := request("/v1/requester-history/facts", factQuery)
	equal(factPage, original("requester-facts", factQuery))
	factQuery["after"] = factPage["nextAfter"]
	equal(request("/v1/requester-history/facts", factQuery), original("requester-facts", factQuery))
	equal(request("/v2/qualification/evaluate", f.OpenQuery), original("evaluate-v2", f.OpenQuery))
	view = request("/v2/qualification/evaluate", f.V2Query)
	equal(view, original("evaluate-v2", f.V2Query))
	if view["state"] != "satisfied" || len(array(view["satisfiedBy"])) != 1 {
		t.Fatal("real scoped v2 participation was not evaluated")
	}
	for _, command := range f.CalculationCommands {
		requestToken = f.Token
		if command.Author {
			requestToken = f.AuthorToken
		}
		receipt := request("/v2/qualification/calculation-permissions", command.Input)
		equal(receipt, request("/v2/qualification/calculation-permissions", command.Input))
		equal(receipt, original("calculation-submit", Object{"author": command.Author, "input": command.Input}))
		equal(request("/v2/qualification/calculation-receipt", command.Receipt), original("calculation-receipt", Object{"author": command.Author, "input": command.Receipt}))
		equal(request("/v2/qualification/calculation-owned", Object{}), original("calculation-owned", Object{"author": command.Author}))
	}
	requestToken = f.Token
	licensed := request("/v2/qualification/evaluate", f.CalculationQuery)
	equal(licensed, original("evaluate-v2", f.CalculationQuery))
	if licensed["state"] != "satisfied" || object(array(licensed["satisfiedBy"])[0])["sourceDetailsDisclosed"] != false {
		t.Fatal("scoped licensed computation did not preserve bounded result")
	}
	requestToken = f.AuthorToken
	equal(request("/v2/qualification/permission-requests/plan", f.PlanQuery), original("permission-plan", Object{}))
	for _, kind := range []string{"participation", "calculation", "legacy-assistance", "proof"} {
		input := Object{"taskId": f.V2Query["taskId"], "kind": kind}
		equal(request("/v2/qualification/candidates", input), original("candidates", input))
	}
	for _, command := range f.RequestCommands {
		requestToken = f.Token
		if command.Author {
			requestToken = f.AuthorToken
		}
		written := request("/v2/qualification/permission-requests/events", command.Input)
		replayed := request("/v2/qualification/permission-requests/events", command.Input)
		equal(replayed, original("permission-submit", Object{"author": command.Author, "input": command.Input}))
		if written["acknowledged"] != true || written["permissionGranted"] != false {
			t.Fatal("permission request write changed original acknowledgment scope")
		}
		equal(request("/v2/qualification/permission-requests/receipt", command.Receipt), original("permission-receipt", Object{"author": command.Author, "input": command.Receipt}))
		for _, author := range []bool{false, true} {
			requestToken = f.Token
			view := "received"
			if author {
				requestToken = f.AuthorToken
				view = "sent"
			}
			equal(request("/v2/qualification/permission-requests/read", Object{"requestId": f.RequestID}), original("permission-read", Object{"author": author}))
			equal(request("/v2/qualification/permission-requests/query", Object{"view": view}), original("permission-query", Object{"author": author}))
			equal(request("/v2/notifications/query", Object{}), original("inbox", Object{"author": author}))
		}
	}
	requestToken = f.AuthorToken
	revoked := request("/v2/qualification/calculation-permissions", f.RevokeCalculation.Input)
	equal(revoked, original("calculation-submit", Object{"author": true, "input": f.RevokeCalculation.Input}))
	equal(request("/v2/qualification/calculation-receipt", f.RevokeCalculation.Receipt), original("calculation-receipt", Object{"author": true, "input": f.RevokeCalculation.Receipt}))
	equal(request("/v2/qualification/calculation-owned", Object{}), original("calculation-owned", Object{"author": true}))
	requestToken = f.Token
	original("revoke-v2-acceptance", nil)
	view = request("/v2/qualification/evaluate", f.V2Query)
	equal(view, original("evaluate-v2", f.V2Query))
	if view["state"] != "insufficient-evidence" {
		t.Fatal("revoked v2 acceptance still established eligibility")
	}
	original("revoke-confirmation", nil)
	view = request("/v1/qualification/evaluate", f.Query)
	equal(view, original("evaluate", f.Query))
	if view["eligible"] != false || len(array(view["unavailable"])) != 1 {
		t.Fatal("revoked source still established current eligibility")
	}
	worker, e := postgres.Open(ctx, dsn+"&options=-c%20role%3Dgalaxy_evidence_worker")
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	for i, at := range []int64{f.Now + 1801, f.Now + 1800 + 180*86400} {
		tx, e := worker.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		retained, e := s.CleanupRequestsWithin(ctx, tx, at)
		_ = tx.Rollback(ctx)
		if e != nil {
			t.Fatal(e)
		}
		equal(retained, original("cleanup-requests", Object{"at": at}))
		if i == 0 && number(retained["qualificationRequestBodies"]) != 3 {
			t.Fatal("expired original request bodies did not minimize")
		}
		if i == 1 && number(retained["qualificationRequestReceipts"]) != 1 {
			t.Fatal("original request receipt retention did not expire")
		}
	}
}
