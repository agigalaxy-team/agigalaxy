//go:build galaxy_a2a_fixture

// Package a2afixture supplies disposable current Go domain HTTP to the A2A
// SDK integration tests. The tag keeps this serving fixture out of ordinary
// go test ./...; the Node fixture selects it explicitly and shuts it down.
package a2afixture

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/cases"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/taskmaterials"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type object = map[string]any

func encode(value any) []byte { raw, _ := json.Marshal(value); return raw }

func TestServeCurrentDomains(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	const endpoint = "https://a2a-fixture.example.invalid"
	const now int64 = 2000000000
	clock := func() time.Time { return time.Unix(now, 0) }
	actors := []deviceauthfixture.Fixture{}
	for range 2 {
		actors = append(actors, deviceauthfixture.NewEndpoint(t, owner, t.TempDir(), []string{"binding", "consent", "case-teaser", "assistance", "history"}, endpoint))
	}
	configuration := owner.Config()
	configuration.AfterConnect = func(ctx context.Context, connection *pgx.Conn) error {
		_, err := connection.Exec(ctx, "SET ROLE galaxy_api")
		return err
	}
	api, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(api.Close)
	devices := &deviceauth.Service{Pool: api, Endpoint: endpoint, Now: clock}
	cs := &cases.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: clock}
	tasks := &taskmaterials.Service{Pool: api, Endpoint: endpoint, Devices: devices, Now: clock, OwnedCaseLive: cs.RequireOwnedCaseLiveWithin, CaseOwnerSource: cs.RequireOwnerSourceWithin, CaseWithin: cs.CaseWithin}
	tasks.ValidateTaskContext = func(ctx context.Context, tx pgx.Tx, actor taskmaterials.Actor, id string, references []any) error {
		rows := make([]cases.Object, len(references))
		for i, reference := range references {
			row, ok := reference.(map[string]any)
			if !ok {
				return fault.New("invalid_request", 400)
			}
			rows[i] = row
		}
		_, err := cs.ValidateTaskContextWithin(ctx, tx, actor.Actor, id, rows)
		return err
	}
	cs.TaskRead = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, id string) (cases.Object, error) {
		return tasks.RequireTaskWithin(ctx, tx, &actor, id, false)
	}
	cs.TaskWrite = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, id string) (cases.Object, error) {
		return tasks.RequireTaskWithin(ctx, tx, &actor, id, true)
	}
	cs.Participation = func(ctx context.Context, tx pgx.Tx, actor deviceauth.Actor, task, id string) (cases.Object, error) {
		return tasks.RequireParticipationWithin(ctx, tx, actor, task, id, false)
	}
	cs.AttachCase = tasks.AttachCaseWithin
	domains := taskmaterials.Handler{Task: tasks, Next: cases.Handler{Service: cs, Devices: devices}}
	controlKey := uuid.NewString()
	done := make(chan struct{})
	var stop sync.Once
	control := http.NewServeMux()
	control.HandleFunc("POST /fixture/shutdown", func(w http.ResponseWriter, r *http.Request) {
		stop.Do(func() { close(done) })
		w.WriteHeader(http.StatusNoContent)
	})
	control.HandleFunc("POST /fixture/authorize", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Actor                            int    `json:"actor"`
			PayloadJSON                      string `json:"payloadJson"`
			Action, ObjectID, ID, Visibility string
			Viewers                          []string
		}
		if json.NewDecoder(io.LimitReader(r.Body, 100001)).Decode(&input) != nil || input.Actor < 0 || input.Actor >= len(actors) {
			http.Error(w, "invalid fixture authorization", 400)
			return
		}
		actor := actors[input.Actor]
		var payload object
		if json.Unmarshal([]byte(input.PayloadJSON), &payload) != nil || payload == nil {
			http.Error(w, "invalid fixture payload", 400)
			return
		}
		fields := []string{}
		for key := range payload {
			fields = append(fields, key)
		}
		if input.ID == "" {
			input.ID = uuid.NewString()
		}
		if input.Visibility == "" {
			input.Visibility = "Private"
		}
		if input.Viewers == nil {
			input.Viewers = []string{}
		}
		purpose := "operational"
		if input.Visibility == "Public" {
			purpose = "public-profile"
		}
		intent := deviceauth.ConsentIntent{Version: 1, ID: input.ID, SubjectID: actor.Actor.SubjectID, BindingID: actor.Actor.BindingID, Endpoint: endpoint, ObjectID: input.ObjectID, Action: input.Action, Purpose: purpose, Recipient: endpoint, Fields: fields, Visibility: input.Visibility, Viewers: input.Viewers, PayloadHash: identity.Digest([]byte(input.PayloadJSON)), PolicyVersion: "0.1", IssuedAt: now, ExpiresAt: now + 3600}
		key, err := identity.PrivatePEM([]byte(actor.Materials.OwnerPrivate))
		if err != nil {
			http.Error(w, "fixture signing unavailable", 500)
			return
		}
		signed, err := identity.SignIdentityPayload(key, string(encode(intent)), "galaxy-consent+jws")
		if err == nil {
			_, err = devices.CaptureConsent(r.Context(), actor.Actor, signed)
		}
		if err != nil {
			w.WriteHeader(fault.Status(err))
			_ = json.NewEncoder(w).Encode(object{"error": fault.Code(err)})
			return
		}
		_ = json.NewEncoder(w).Encode(object{"consentId": intent.ID, "payloadJson": input.PayloadJSON})
	})
	control.HandleFunc("POST /fixture/revoke", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Actor     int
			ConsentID string
		}
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.Actor < 0 || input.Actor >= len(actors) {
			http.Error(w, "invalid fixture actor", 400)
			return
		}
		value, err := devices.RevokeConsent(r.Context(), actors[input.Actor].Actor, input.ConsentID, nil)
		if err != nil {
			w.WriteHeader(fault.Status(err))
			_ = json.NewEncoder(w).Encode(object{"error": fault.Code(err)})
			return
		}
		_ = json.NewEncoder(w).Encode(value)
	})
	control.HandleFunc("POST /fixture/erase-case-content", func(w http.ResponseWriter, r *http.Request) {
		var input struct{ ID string }
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			http.Error(w, "invalid fixture event", 400)
			return
		}
		if _, err := owner.Exec(r.Context(), `UPDATE case_events SET payload='{}'::jsonb,payload_text='' WHERE id=$1`, input.ID); err != nil {
			http.Error(w, "fixture content erase failed", 500)
			return
		}
		_ = json.NewEncoder(w).Encode(object{"rows": []any{}})
	})
	control.HandleFunc("POST /fixture/case-counts", func(w http.ResponseWriter, r *http.Request) {
		rows, err := owner.Query(r.Context(), `SELECT kind,count(*)::int FROM case_events GROUP BY kind ORDER BY kind`)
		if err != nil {
			http.Error(w, "fixture count failed", 500)
			return
		}
		defer rows.Close()
		out := []object{}
		for rows.Next() {
			var kind string
			var count int
			if rows.Scan(&kind, &count) != nil {
				http.Error(w, "fixture count failed", 500)
				return
			}
			out = append(out, object{"kind": kind, "count": count})
		}
		_ = json.NewEncoder(w).Encode(object{"rows": out})
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) >= 9 && r.URL.Path[:9] == "/fixture/" {
			if r.Header.Get("X-Galaxy-Fixture-Key") != controlKey {
				http.Error(w, "fixture control denied", 403)
				return
			}
			control.ServeHTTP(w, r)
			return
		}
		domains.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	metadata := []object{}
	for _, actor := range actors {
		metadata = append(metadata, object{"actor": object{"subjectId": actor.Actor.SubjectID, "bindingId": actor.Actor.BindingID}, "credential": actor.Credential})
	}
	fmt.Println("GALAXY_A2A_FIXTURE " + string(encode(object{"origin": server.URL, "endpoint": endpoint, "now": now, "controlKey": controlKey, "actors": metadata})))
	select {
	case <-done:
	case <-time.After(3 * time.Minute):
		t.Fatal("A2A caller did not close its disposable Go fixture")
	}
}
