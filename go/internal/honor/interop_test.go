package honor

import (
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
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/qualificationfixture"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOriginalCurrentScopedHonor(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	var f struct {
		Endpoint, Token, AuthorToken string
		PublishCommands              map[string][]struct{ SubjectID, ConsentID, PayloadJSON string }
		Now                          int64
		HonorRules                   []Object
		Policy, Query                Object
		LegacyID                     string
	}
	qualificationfixture.Publication(t, owner, &f)
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
	publish := func(action string) {
		t.Helper()
		for _, command := range f.PublishCommands[action] {
			var author deviceauth.Actor
			for _, token := range []string{f.Token, f.AuthorToken} {
				candidate, err := devices.Authenticate(ctx, token, "history")
				if err != nil {
					t.Fatal(err)
				}
				if candidate.SubjectID == command.SubjectID {
					author = candidate
					break
				}
			}
			if author.SubjectID == "" {
				t.Fatal("publication author absent")
			}
			if _, err := sharing.Submit(ctx, contributions.Actor{Actor: author}, contributions.Envelope{ConsentID: command.ConsentID, PayloadJSON: command.PayloadJSON}); err != nil {
				t.Fatal("Go publication", err)
			}
		}
	}
	_ = request("/v1/honor/rules", Object{}, false, 200)
	subject := f.Query["subjectId"]
	for _, v2 := range []bool{false, true} {
		id, version := "scoped-contribution", "v1"
		if v2 {
			id, version = "scoped-facts", "v2"
		}
		query := Object{"ruleId": id, "ruleVersion": "1", "subjectId": subject}
		for _, anonymous := range []bool{false, true} {
			_ = request("/"+version+"/honor/query", query, !anonymous, 200)
		}
		ranking := Object{"ruleId": id, "ruleVersion": "1"}
		_ = request("/"+version+"/honor/ranking", ranking, false, 200)
	}
	detail := Object{"ruleId": "scoped-contribution", "ruleVersion": "1", "subjectId": subject, "sourceId": f.LegacyID, "sourceAfter": 1, "limit": 1}
	_ = request("/v1/honor/query", detail, true, 200)
	publish("honor-publish")
	publicQuery := Object{"ruleId": "scoped-facts", "ruleVersion": "1", "subjectId": subject, "includeSimulation": true}
	public := request("/v2/honor/query", publicQuery, false, 200)
	_ = public
	if object(public["card"])["status"] != "active" {
		t.Fatalf("real selected public sources not active: %v", public)
	}
	raw, _ := json.Marshal(public)
	if bytes.Contains(raw, []byte("Current agreed work scope")) || bytes.Contains(raw, []byte("Explicit selected work")) {
		t.Fatal("unselected private text disclosed")
	}
	fingerprint := public["sourceFingerprint"]
	var acceptID string
	if e = owner.QueryRow(ctx, `SELECT consent_id::text FROM task_events WHERE kind='accept' LIMIT 1`).Scan(&acceptID); e != nil {
		t.Fatal(e)
	}
	author, e := devices.Authenticate(ctx, f.Token, "consent")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = devices.RevokeConsent(ctx, author, acceptID, nil); e != nil {
		t.Fatal(e)
	}
	_ = request("/v2/honor/query", publicQuery, false, 200)
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
	if risk.Values()["fraudDetermined"] != false || risk.Values()["automaticPenalty"] != false || len(array(risk.Values()["flags"])) == 0 {
		t.Fatal("risk must remain review only", risk)
	}
	if len(array(paged["contributions"])) != 1 || object(paged["riskDetail"])["index"] == nil {
		t.Fatal("bounded risk pagination", paged)
	}
}
