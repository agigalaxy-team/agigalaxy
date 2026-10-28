package requesterhistory

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestOriginalRequesterCurrentSources(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/qualification-interop.mjs"), "requester")
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
			t.Errorf("original fixture %v: %s", e, stderr.String())
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
		t.Fatalf("original fixture %s", stderr.String())
	}
	var f struct {
		Endpoint, Token, Bridge string
		Now                     int64
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
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	sharing := &contributions.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Tasks: tasks, Now: now}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Sharing: sharing, Now: now}
	h := Handler{Service: s}
	actor, e := devices.Authenticate(ctx, f.Token, "assistance")
	if e != nil {
		t.Fatal(e)
	}
	var rootID string
	if e = pool.QueryRow(ctx, "SELECT root_event_id FROM task_requests WHERE case_id IS NOT NULL").Scan(&rootID); e != nil {
		t.Fatal(e)
	}
	original := func(action string, input Object) Object {
		t.Helper()
		raw, _ := json.Marshal(Object{"action": action, "query": input})
		r, _ := http.NewRequestWithContext(ctx, "POST", f.Bridge, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		res, e := http.DefaultClient.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var v Object
		if e = json.NewDecoder(res.Body).Decode(&v); e != nil {
			t.Fatal(e)
		}
		if res.StatusCode != 200 {
			t.Fatalf("original %s %d %v", action, res.StatusCode, v)
		}
		return v
	}
	request := func(path string, input Object, auth bool, status int) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		if auth {
			r.Header.Set("Authorization", "Bearer "+f.Token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("Go %s %d %s", path, w.Code, w.Body.String())
		}
		var v Object
		if e = json.Unmarshal(w.Body.Bytes(), &v); e != nil {
			t.Fatal(e)
		}
		return v
	}
	equal := func(actual, expected Object) {
		t.Helper()
		a, _ := json.Marshal(actual)
		b, _ := json.Marshal(expected)
		if string(a) != string(b) {
			t.Fatalf("requester differs Go=%s original=%s", a, b)
		}
	}
	query := Object{"subjectId": actor.SubjectID, "limit": 1}
	facts := Object{"rootEventId": rootID, "limit": 1}
	for _, anonymous := range []bool{false, true} {
		equal(request("/v2/requester-history/query", query, !anonymous, 200), original("requester-v2-query", Object{"anonymous": anonymous, "input": query}))
		if !anonymous {
			first := request("/v2/requester-history/facts", facts, true, 200)
			equal(first, original("requester-v2-facts", Object{"input": facts}))
			if first["nextAfter"] != nil {
				next := Object{"rootEventId": rootID, "after": first["nextAfter"], "limit": 1}
				equal(request("/v2/requester-history/facts", next, true, 200), original("requester-v2-facts", Object{"input": next}))
			}
		}
	}
	original("requester-publish", nil)
	equal(request("/v2/requester-history/query", query, false, 200), original("requester-v2-query", Object{"anonymous": true, "input": query}))
	equal(request("/v2/requester-history/facts", facts, false, 200), original("requester-v2-facts", Object{"anonymous": true, "input": facts}))
	original("revoke-v2-acceptance", nil)
	equal(request("/v2/requester-history/query", query, false, 200), original("requester-v2-query", Object{"anonymous": true, "input": query}))
	original("revoke-v2-root", nil)
	equal(request("/v2/requester-history/query", query, false, 200), original("requester-v2-query", Object{"anonymous": true, "input": query}))
	stale := Object{"subjectId": actor.SubjectID, "after": rootID}
	if v := request("/v2/requester-history/query", stale, false, 409); v["error"] != "requester_history_cursor_unavailable" {
		t.Fatal(v)
	}
}
