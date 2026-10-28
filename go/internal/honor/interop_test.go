package honor

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/civ2"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/evidence"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
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

func TestOriginalCurrentScopedHonor(t *testing.T) {
	_, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	root, _ := filepath.Abs("../../..")
	dir := t.TempDir()
	cmd := exec.CommandContext(ctx, "node", filepath.Join(root, "scripts/go/qualification-interop.mjs"), "honor")
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
		HonorRules              []Object
		Policy, Query           Object
		LegacyID                string
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
	proofs := &evidence.ProofService{}
	q, e := qualification.New(pool, f.Endpoint, devices, []Object{f.Policy}, now)
	if e != nil {
		t.Fatal(e)
	}
	q.Assistance = tasks
	q.Cases = cs
	q.Proofs = proofs
	sharing := &contributions.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Tasks: tasks, Now: now}
	s, e := New(pool, f.Endpoint, devices, f.HonorRules, now)
	if e != nil {
		t.Fatal(e)
	}
	s.Assistance = tasks
	s.Proofs = proofs
	s.Qualification = q
	s.Sharing = sharing
	s.CI = &civ2.Service{Pool: pool, Endpoint: f.Endpoint, Devices: devices, Now: now}
	h := Handler{Service: s}
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
			t.Fatalf("Honor differs Go=%s original=%s", a, b)
		}
	}
	equal(request("/v1/honor/rules", Object{}, false, 200), original("honor-list", nil))
	subject := f.Query["subjectId"]
	for _, v2 := range []bool{false, true} {
		id, version, action := "scoped-contribution", "v1", "honor-query"
		if v2 {
			id, version, action = "scoped-facts", "v2", "honor-v2-query"
		}
		query := Object{"ruleId": id, "ruleVersion": "1", "subjectId": subject}
		for _, anonymous := range []bool{false, true} {
			equal(request("/"+version+"/honor/query", query, !anonymous, 200), original(action, Object{"anonymous": anonymous, "input": query}))
		}
		ranking := Object{"ruleId": id, "ruleVersion": "1"}
		rankingAction := "honor-ranking"
		if v2 {
			rankingAction = "honor-v2-ranking"
		}
		equal(request("/"+version+"/honor/ranking", ranking, false, 200), original(rankingAction, ranking))
	}
	detail := Object{"ruleId": "scoped-contribution", "ruleVersion": "1", "subjectId": subject, "sourceId": f.LegacyID, "sourceAfter": 1, "limit": 1}
	equal(request("/v1/honor/query", detail, true, 200), original("honor-query", Object{"input": detail}))
	original("honor-publish", nil)
	publicQuery := Object{"ruleId": "scoped-facts", "ruleVersion": "1", "subjectId": subject, "includeSimulation": true}
	public := request("/v2/honor/query", publicQuery, false, 200)
	equal(public, original("honor-v2-query", Object{"anonymous": true, "input": publicQuery}))
	if object(public["card"])["status"] != "active" {
		t.Fatalf("real selected public sources not active: %v", public)
	}
	raw, _ = json.Marshal(public)
	if bytes.Contains(raw, []byte("Current agreed work scope")) || bytes.Contains(raw, []byte("Explicit selected work")) {
		t.Fatal("unselected private text disclosed")
	}
	fingerprint := public["sourceFingerprint"]
	original("revoke-v2-acceptance", nil)
	equal(request("/v2/honor/query", publicQuery, false, 200), original("honor-v2-query", Object{"anonymous": true, "input": publicQuery}))
	publicQuery["expectedFingerprint"] = fingerprint
	if v := request("/v2/honor/query", publicQuery, false, 409); v["error"] != "honor_sources_changed_retry" {
		t.Fatalf("stale fingerprint %v", v)
	}
}

func TestOriginalRiskAndPagination(t *testing.T) {
	now := int64(1800000000)
	// Algorithm-only vectors supplement the real source chain above: large
	// references, current CI conflicts and reciprocal reported acceptance.
	items := []Object{}
	for i := 0; i < 21; i++ {
		requester, provider := "a", "b"
		if i%2 == 1 {
			requester, provider = provider, requester
		}
		conclusion := "success"
		if i%2 == 1 {
			conclusion = "failure"
		}
		proof := Object{"proofId": fmt.Sprintf("proof-%d", i), "evidenceId": "evidence", "sourceKey": "same-source", "commit": fmt.Sprint(i), "conclusion": conclusion}
		items = append(items, Object{"assistanceId": fmt.Sprintf("assistance-%02d", i), "caseId": fmt.Sprintf("case-%d", i%2), "subjectId": provider, "requesterId": requester, "participatedAt": now, "eligible": true, "accepted": true, "independence": "issuer-declared-related-party", "corrected": true, "correctionPending": true, "correctionReview": Object{"state": "participant-reaccepted", "deliveredCaseReviewVersion": 1, "deliveryEventId": "delivery", "acceptanceEventId": "acceptance"}, "sourceEvents": []any{Object{"eventId": fmt.Sprintf("accept-%d", i), "kind": "accept"}}, "proofs": []any{proof}, "observations": []any{proof}})
	}
	risk := AssessRisk(items, true, now, "a", &legacySources{Contributions: items, Complete: true})
	sources := []any{}
	for _, v := range items {
		sources = append(sources, v)
	}
	view := Object{"card": Object{"sourceFingerprint": "f", "evidence": []any{}, "proofs": []any{}}, "contributions": sources, "riskAssessment": risk}
	pq := Object{"riskIndex": len(array(risk.Values()["flags"])) - 1, "riskReferenceAfter": 1, "limit": 1}
	paged, e := paginate(view, pq)
	if e != nil {
		t.Fatal(e)
	}
	root, _ := filepath.Abs("../../..")
	file := filepath.Join(t.TempDir(), "algorithm.json")
	raw, _ := json.Marshal(Object{"items": items, "now": now})
	if e = os.WriteFile(file, raw, 0600); e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("node", filepath.Join(root, "scripts/go/qualification-interop.mjs"), "honor-algorithms", file)
	cmd.Dir = root
	raw, e = cmd.CombinedOutput()
	if e != nil {
		t.Fatalf("original algorithms %v: %s", e, raw)
	}
	var expected Object
	if e = json.Unmarshal(raw, &expected); e != nil {
		t.Fatal(e)
	}
	actualRaw, _ := json.Marshal(Object{"risk": risk, "paged": paged})
	var normalized Object
	_ = json.Unmarshal(actualRaw, &normalized)
	actualRaw, _ = json.Marshal(normalized)
	expectedRaw, _ := json.Marshal(expected)
	if string(actualRaw) != string(expectedRaw) {
		t.Fatalf("algorithm differs Go=%s original=%s", actualRaw, expectedRaw)
	}
}
