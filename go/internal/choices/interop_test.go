package choices

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/historyv2"
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

func TestOriginalOwnerChoiceSourcesAndReceipt(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/qualification-interop.mjs"), "choices")
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
	cs := &cases.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now, CaseOwnerSource: cs.RequireOwnerSourceWithin}
	history := &historyv2.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Tasks: tasks.ReadHistoryWireWithin, Now: now}
	reader := &Reader{Tasks: tasks, History: history}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Sources: reader, Now: now}
	h := Handler{Service: s}
	actor, e := devices.Authenticate(ctx, f.Token, "binding")
	if e != nil {
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
	request := func(action string, input Object, status int) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", "/v2/choice-snapshots/"+action, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+f.Token)
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
		var normal Object
		_ = json.Unmarshal(a, &normal)
		a, _ = json.Marshal(normal)
		b, _ := json.Marshal(expected)
		if string(a) != string(b) {
			t.Fatalf("Choice differs Go=%s original=%s", a, b)
		}
	}
	fixture := original("choice-fixture", nil)
	pref := object(fixture["preference"])
	puts := array(fixture["puts"])
	receipts := array(fixture["receipts"])
	get := Object{"snapshotId": pref["snapshotIds"].([]any)[0]}
	equal(request("preferences/read", Object{}, 200), original("choice-preferences", nil))
	equal(request("preferences/save", pref, 200), original("choice-preferences", nil))
	first := object(puts[0])
	parsedFirst, e := Parse("put", first)
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range array(parsedFirst["witnesses"]) {
		tx, e := pool.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		w, e := reader.WitnessWithin(ctx, tx, actor, object(v))
		_ = tx.Rollback(ctx)
		if e != nil {
			t.Fatal(e)
		}
		equal(w, original("choice-witness", object(v)))
	}
	for i, v := range puts {
		put := object(v)
		parsed, e := Parse("put", put)
		if e != nil {
			t.Fatal(e)
		}
		hash, e := digestIntent(PutIntent(parsed))
		if e != nil {
			t.Fatal(e)
		}
		if hash != object(receipts[i])["requestHash"] {
			t.Fatalf("original intent hash %s %v", hash, receipts[i])
		}
		out := request("put", put, 200)
		delete(out, "operationVersionId")
		delete(out, "syncState")
		equal(out, original("choice-get", get))
		equal(request("receipt", object(receipts[i]), 200), original("choice-receipt", object(receipts[i])))
		equal(request("put", put, 200), original("choice-put", put))
	}
	equal(request("list", Object{}, 200), original("choice-list", Object{}))
	original("choice-revoke-root", nil)
	current := request("get", get, 200)
	equal(current, original("choice-get", get))
	if object(object(current["current"])["content"])["visibleRationale"] != nil || object(object(current["current"])["content"])["rationaleUnavailable"] != true {
		t.Fatal("revoked source retained current rationale")
	}
	receipt := object(receipts[0])
	equal(request("receipt", receipt, 200), original("choice-receipt", receipt))
	request("delete", Object{"snapshotId": get["snapshotId"], "expectedRevision": 2}, 200)
	equal(request("get", get, 200), original("choice-get", get))
	equal(request("receipt", receipt, 200), original("choice-receipt", receipt))
	wrong := Object{"snapshotId": receipt["snapshotId"], "versionId": receipt["versionId"], "requestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	if request("receipt", wrong, 200)["state"] != "conflict" {
		t.Fatal("mismatched accepted intent")
	}
}
