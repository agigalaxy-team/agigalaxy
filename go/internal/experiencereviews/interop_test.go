package experiencereviews

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
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/jackc/pgx/v5"
)

func TestOriginalExperienceCurrentSourcesAndQualification(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
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
		Endpoint, Token, AuthorToken, Bridge, Issuer, ExperienceID, ReviewID string
		Now                                                                  int64
		ExperienceReviewer, Policy, V2Query                                  Object
		ExperienceCommands                                                   []struct {
			Author bool
			Input  Envelope
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
	s, e := New(pool, f.Endpoint, devices, []Object{f.ExperienceReviewer}, now)
	if e != nil {
		t.Fatal(e)
	}
	s.Links = links
	cs := &cases.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	tasks := &taskmaterials.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now, CaseOwnerSource: cs.RequireOwnerSourceWithin}
	q, e := qualification.New(pool, f.Endpoint, devices, []Object{f.Policy}, now)
	if e != nil {
		t.Fatal(e)
	}
	q.Assistance = tasks
	q.Cases = cs
	q.ReadExperienceReview = func(ctx context.Context, tx pgx.Tx, a deviceauth.Actor, ref Object) (Object, error) {
		return s.ReadWithin(ctx, tx, &a, str(ref, "id"), number(ref["version"]))
	}
	q.ReadExperienceCalculation = s.ReadCalculationWithin
	handler := Handler{Service: s, Next: qualification.Handler{Service: q}}
	token := f.Token
	decode := func(raw []byte) Object {
		t.Helper()
		v, e := decodeValue(raw)
		if e != nil {
			t.Fatal(e)
		}
		return object(v)
	}
	request := func(path string, input any) Object {
		t.Helper()
		raw, _ := json.Marshal(input)
		r := httptest.NewRequest("POST", path, bytes.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("experience HTTP %s: status %d %s", path, w.Code, w.Body.String())
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
			t.Fatalf("original experience status %d: %s", res.StatusCode, raw)
		}
		return decode(raw)
	}
	equal := func(actual, expected Object) {
		t.Helper()
		a, _ := json.Marshal(actual)
		b, _ := json.Marshal(expected)
		if string(a) != string(b) {
			t.Fatalf("original experience differs Go=%s original=%s", a, b)
		}
	}
	for i, command := range f.ExperienceCommands {
		token = f.Token
		if command.Author {
			token = f.AuthorToken
		}
		written := request("/v2/experience/submit", command.Input)
		if written["capabilityVerified"] != false {
			t.Fatal("experience write invented capability verification")
		}
		replay := request("/v2/experience/submit", command.Input)
		equal(replay, original("experience-submit", Object{"author": command.Author, "input": command.Input}))
		var p Object
		if e = json.Unmarshal([]byte(command.Input.PayloadJSON), &p); e != nil {
			t.Fatal(e)
		}
		for _, author := range []bool{false, true} {
			token = f.Token
			if author {
				token = f.AuthorToken
			}
			for _, ref := range []Object{{"id": p["id"]}, {"id": p["id"], "version": 1}} {
				equal(request("/v2/experience/read", ref), original("experience-read", Object{"author": author, "input": ref}))
			}
		}
		if i == 1 || i == 3 || i == 4 {
			token = f.Token
			version := 1
			if i >= 3 {
				version = 2
			}
			input := Object{"taskId": f.V2Query["taskId"], "subjectId": f.V2Query["subjectId"], "evidence": Object{"externalReviewRefs": []any{Object{"id": f.ReviewID, "version": version}}}}
			equal(request("/v2/qualification/evaluate", input), original("evaluate-v2", input))
		}
	}
}
