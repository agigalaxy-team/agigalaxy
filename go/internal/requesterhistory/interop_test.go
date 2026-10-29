package requesterhistory

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/contributions"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/postgres"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/qualificationfixture"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOriginalRequesterCurrentSources(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	var f struct {
		Endpoint, Token, AuthorToken string
		PublishCommands              map[string][]struct{ SubjectID, ConsentID, PayloadJSON string }
		Now                          int64
	}
	qualificationfixture.Publication(t, owner, &f)
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
	query := Object{"subjectId": actor.SubjectID, "limit": 1}
	facts := Object{"rootEventId": rootID, "limit": 1}
	for _, anonymous := range []bool{false, true} {
		page := request("/v2/requester-history/query", query, !anonymous, 200)
		if anonymous && len(array(page["items"])) != 0 {
			t.Fatal("private source visible before publication", page)
		}
		if !anonymous {
			first := request("/v2/requester-history/facts", facts, true, 200)
			_ = first
			if first["nextAfter"] != nil {
				next := Object{"rootEventId": rootID, "after": first["nextAfter"], "limit": 1}
				_ = request("/v2/requester-history/facts", next, true, 200)
			}
		}
	}
	publish("requester-publish")
	public := request("/v2/requester-history/query", query, false, 200)
	if len(array(public["items"])) != 1 || object(object(array(public["items"])[0])["source"])["id"] != rootID {
		t.Fatal("selected public source missing", public)
	}
	_ = request("/v2/requester-history/facts", facts, false, 200)
	var acceptID string
	if e = owner.QueryRow(ctx, `SELECT consent_id::text FROM task_events WHERE kind='accept' LIMIT 1`).Scan(&acceptID); e != nil {
		t.Fatal(e)
	}
	if _, e = devices.RevokeConsent(ctx, actor, acceptID, nil); e != nil {
		t.Fatal(e)
	}
	_ = request("/v2/requester-history/query", query, false, 200)
	var rootConsent string
	if e = owner.QueryRow(ctx, `SELECT consent_id::text FROM task_events WHERE id=$1`, rootID).Scan(&rootConsent); e != nil {
		t.Fatal(e)
	}
	if _, e = devices.RevokeConsent(ctx, actor, rootConsent, nil); e != nil {
		t.Fatal(e)
	}
	if gone := request("/v2/requester-history/query", query, false, 200); len(array(gone["items"])) != 0 {
		t.Fatal("revoked root remained public", gone)
	}
	stale := Object{"subjectId": actor.SubjectID, "after": rootID}
	if v := request("/v2/requester-history/query", stale, false, 409); v["error"] != "requester_history_cursor_unavailable" {
		t.Fatal(v)
	}
}
