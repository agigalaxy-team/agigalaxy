package contributions

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

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/jstext"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
)

func TestOriginalSelectedPublicationAndCurrentMaterial(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/qualification-interop.mjs"), "contributions")
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
	ready := false
	scanner := bufio.NewScanner(stdout)
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
		Endpoint, Token, Issuer, Bridge string
		Now                             int64
		ContributionFixture             struct {
			Publication, Ref, Preview, Sources, Read, Opaque Object
			Publish, Revoke                                  Envelope
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
	links := &accountlinks.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Providers: []accountlinks.Provider{{Issuer: f.Issuer, ClientID: "galaxy-fixture"}}, Now: now}
	forum := &community.Service{Pool: pool, Endpoint: f.Endpoint, DeviceAuth: devices, AccountLinks: links, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now, Forum: taskmaterials.ForumSourceAdapter(forum.TaskMaterialSourceWithin)}
	s := &Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Tasks: tasks, Now: now}
	handler := Handler{Service: s}
	decode := func(raw []byte) Object {
		t.Helper()
		v, e := jstext.DecodeJSON(raw)
		if e != nil {
			t.Fatal(e)
		}
		return object(v)
	}
	request := func(path string, input any, authenticated bool, status int) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		if authenticated {
			r.Header.Set("Authorization", "Bearer "+f.Token)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("contribution HTTP %s: status %d %s", path, w.Code, w.Body.String())
		}
		return decode(w.Body.Bytes())
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
		raw, _ = io.ReadAll(res.Body)
		if res.StatusCode != 200 {
			t.Fatalf("original contribution status %d: %s", res.StatusCode, raw)
		}
		return decode(raw)
	}
	equal := func(actual, expected Object) {
		t.Helper()
		a, _ := json.Marshal(actual)
		normalized := decode(a)
		a, _ = json.Marshal(normalized)
		b, _ := json.Marshal(expected)
		if string(a) != string(b) {
			t.Fatalf("original contribution differs Go=%s original=%s", a, b)
		}
	}
	refs := f.ContributionFixture
	request("/v2/contributions/read", refs.Read, false, 404)
	equal(request("/v2/contributions/sources", refs.Sources, true, 200), original("contribution-sources", refs.Sources))
	equal(request("/v2/contributions/preview", refs.Preview, true, 200), original("contribution-preview", refs.Preview))
	for _, input := range []Envelope{refs.Publish, refs.Publish} {
		written := request("/v2/contributions/publish", input, true, 200)
		raw, _ := json.Marshal(input)
		equal(written, original("contribution-submit", object(decode(raw))))
	}
	statusInput := Object{"publicationId": refs.Publication["id"]}
	equal(request("/v2/contributions/status", statusInput, true, 200), original("contribution-status", statusInput))
	for _, input := range []Object{refs.Read, refs.Opaque} {
		visible := request("/v2/contributions/read", input, false, 200)
		equal(visible, original("contribution-read", Object{"input": input}))
		projection := object(visible["projection"])
		if projection["title"] != "Selected public source title" || len(projection) != 4 || projection["summary"] != nil || object(projection["textView"])["materials"] != nil {
			t.Fatal("bounded publication disclosed unselected Task fields")
		}
	}
	_, e = postgres.InTx(ctx, pool, func(tx pgx.Tx) (any, error) {
		source, e := s.SourceWithin(ctx, tx, refs.Ref)
		if e != nil {
			return nil, e
		}
		permission, e := s.AuthorizeWithin(ctx, tx, nil, "task-event", source, "honor")
		if e != nil {
			return nil, e
		}
		wire, e := s.ProjectOrderedWithin(ctx, tx, nil, source, permission.Fields, permission)
		if e != nil {
			return nil, e
		}
		encoded, e := protocol.EncodeJS(wire)
		if e != nil {
			return nil, e
		}
		expected := original("contribution-wire", refs.Read)
		if string(encoded) != str(expected, "json") {
			t.Fatalf("original selected material wire differs Go=%s original=%s", encoded, str(expected, "json"))
		}
		return nil, nil
	})
	if e != nil {
		t.Fatal(e)
	}
	wrongPurpose := Object{"source": refs.Ref, "purpose": "requester-history"}
	request("/v2/contributions/read", wrongPurpose, false, 404)
	for _, input := range []Envelope{refs.Revoke, refs.Revoke} {
		written := request("/v2/contributions/publish", input, true, 200)
		raw, _ := json.Marshal(input)
		equal(written, original("contribution-submit", object(decode(raw))))
	}
	equal(request("/v2/contributions/status", statusInput, true, 200), original("contribution-status", statusInput))
	request("/v2/contributions/read", refs.Read, false, 404)
	equal(request("/v2/contributions/read", refs.Read, true, 200), original("contribution-read", Object{"authenticated": true, "input": refs.Read}))
}
