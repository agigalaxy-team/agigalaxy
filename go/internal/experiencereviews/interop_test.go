package experiencereviews

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/qualification"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/qualificationfixture"
	"github.com/jackc/pgx/v5"
)

func TestOriginalExperienceCurrentSourcesAndQualification(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	var f struct {
		Endpoint, Token, AuthorToken, Bridge, Issuer, ExperienceID, ReviewID string
		Now                                                                  int64
		ExperienceReviewer, Policy, V2Query                                  Object
		ExperienceCommands                                                   []struct {
			Author bool
			Input  Envelope
		}
	}
	qualificationfixture.New(t, owner, &f)
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
		if replay["acknowledged"] != true || replay["id"] != written["id"] || replay["operationId"] != written["operationId"] {
			t.Fatal("original operation replay", replay)
		}
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
				_ = request("/v2/experience/read", ref)
			}
		}
		if i == 1 || i == 3 || i == 4 {
			token = f.Token
			version := 1
			if i >= 3 {
				version = 2
			}
			input := Object{"taskId": f.V2Query["taskId"], "subjectId": f.V2Query["subjectId"], "evidence": Object{"externalReviewRefs": []any{Object{"id": f.ReviewID, "version": version}}}}
			_ = request("/v2/qualification/evaluate", input)
		}
	}
}
