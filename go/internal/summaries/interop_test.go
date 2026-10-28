package summaries

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestOriginalOwnerSummaryCurrentMetadataAndReceipt(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/personal-summary-interop.mjs"))
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn, "GALAXY_GO_TEST_SUMMARIES_DIR="+dir)
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
		Endpoint, Token, OtherToken, Issuer, Bridge, SummaryID, RoomID string
		Now                                                            int64
		Preference, Source                                             Object
		Puts                                                           []Object
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
	links := &accountlinks.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Providers: []accountlinks.Provider{{Issuer: f.Issuer, ClientID: "galaxy-fixture"}}, Now: now}
	rooms := &chat.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Links: links, Now: now}
	s, e := New(pool, f.Endpoint, devices, now)
	if e != nil {
		t.Fatal(e)
	}
	s.Source = rooms.SummarySourceWithin
	s.ErasureSource = rooms.SummaryErasureSourceWithin
	h := Handler{Service: s}
	original := func(action string, input Object) Object {
		t.Helper()
		raw, _ := json.Marshal(Object{"action": action, "input": input})
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
	request := func(action string, input Object, other bool, status int) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/v2/personal-summaries/"+action, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		token := f.Token
		if other {
			token = f.OtherToken
		}
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("Go %s %d %s", action, w.Code, w.Body.String())
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
			t.Fatalf("Summary differs Go=%s original=%s", a, b)
		}
	}
	get := Object{"summaryId": f.SummaryID}
	equal(request("preferences/read", Object{}, false, 200), original("preferences", nil))
	equal(request("preferences/save", f.Preference, false, 200), original("preferences", nil))
	equal(request("sources", f.Source, false, 200), original("sources", f.Source))
	for _, put := range f.Puts {
		out := request("put", put, false, 200)
		delete(out, "operationVersionId")
		delete(out, "syncState")
		equal(out, original("get", get))
		equal(request("put", put, false, 200), original("put", put))
		receipt := Object{"summaryId": f.SummaryID, "versionId": put["versionId"]}
		equal(request("receipt", receipt, false, 200), original("receipt", receipt))
		if request("receipt", receipt, true, 200)["state"] != "absent" {
			t.Fatal("other owner saw accepted operation")
		}
	}
	equal(request("list", Object{}, false, 200), original("list", Object{}))
	if request("get", get, true, 200)["current"] != nil {
		t.Fatal("other owner saw personal summary")
	}
	second, _ := clone(f.Puts[0])
	second["summaryId"], second["versionId"] = uuid.NewString(), uuid.NewString()
	request("put", second, false, 200)
	original("pending-edit", nil)
	equal(request("sources", f.Source, false, 200), original("sources", f.Source))
	temporary := request("get", get, false, 200)
	equal(temporary, original("get", get))
	version := object(object(temporary["current"]))
	if version["sourcesTemporarilyUnavailable"] != true || len(array(object(version["content"])["fragments"])) != 1 {
		t.Fatalf("temporary projection %v", temporary)
	}
	var retained int
	if e = pool.QueryRow(ctx, "SELECT jsonb_array_length(content->'fragments') FROM personal_summary_versions WHERE version_id=$1", f.Puts[2]["versionId"]).Scan(&retained); e != nil || retained != 2 {
		t.Fatalf("temporary source erased retained body %d %v", retained, e)
	}
	expectedMaintenance := original("purge-invalid-rollback", Object{})
	maintenance, e := s.PurgeInvalidSources(ctx, "", 20)
	if e != nil {
		t.Fatal(e)
	}
	equal(maintenance, expectedMaintenance)
	if number(maintenance["changed"]) != 0 {
		t.Fatal("temporary source pass erased persistent fragments")
	}
	original("complete-edit", nil)
	expected := original("get-rollback", get)
	permanent := request("get", get, false, 200)
	equal(permanent, expected)
	if object(permanent["current"])["sourcesTemporarilyUnavailable"] != false {
		t.Fatal("changed original revision treated as temporary")
	}
	if e = pool.QueryRow(ctx, "SELECT jsonb_array_length(content->'fragments') FROM personal_summary_versions WHERE version_id=$1", f.Puts[2]["versionId"]).Scan(&retained); e != nil || retained != 1 {
		t.Fatalf("permanent old revision retained %d %v", retained, e)
	}
	expectedMaintenance = original("purge-invalid-rollback", Object{})
	maintenance, e = s.PurgeInvalidSources(ctx, "", 20)
	if e != nil {
		t.Fatal(e)
	}
	equal(maintenance, expectedMaintenance)
	if number(maintenance["changed"]) != 1 {
		t.Fatalf("current owner replica maintenance %v", maintenance)
	}
	if e = pool.QueryRow(ctx, "SELECT jsonb_array_length(content->'fragments') FROM personal_summary_versions WHERE version_id=$1", second["versionId"]).Scan(&retained); e != nil || retained != 1 {
		t.Fatalf("trusted metadata cleanup %d %v", retained, e)
	}
	receipt := Object{"summaryId": f.SummaryID, "versionId": f.Puts[0]["versionId"]}
	equal(request("receipt", receipt, false, 200), original("receipt", receipt))
	request("delete", Object{"summaryId": f.SummaryID, "expectedRevision": 2}, false, 200)
	equal(request("receipt", receipt, false, 200), original("receipt", receipt))
}
