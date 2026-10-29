package contributions

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
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
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/qualificationfixture"
	"github.com/jackc/pgx/v5"
)

func TestOriginalSelectedPublicationAndCurrentMaterial(t *testing.T) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
	defer cancel()
	var f struct {
		Endpoint, Token, Issuer, Bridge string
		Now                             int64
		ContributionFixture             struct {
			Publication, Ref, Preview, Sources, Read, Opaque Object
			Publish, Revoke                                  Envelope
		}
	}
	qualificationfixture.SelectedMaterial(t, owner, &f)
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
	refs := f.ContributionFixture
	request("/v2/contributions/read", refs.Read, false, 404)
	_ = request("/v2/contributions/sources", refs.Sources, true, 200)
	_ = request("/v2/contributions/preview", refs.Preview, true, 200)
	for _, input := range []Envelope{refs.Publish, refs.Publish} {
		written := request("/v2/contributions/publish", input, true, 200)
		if written == nil {
			t.Fatal("missing publication acknowledgement")
		}
	}
	statusInput := Object{"publicationId": refs.Publication["id"]}
	_ = request("/v2/contributions/status", statusInput, true, 200)
	for _, input := range []Object{refs.Read, refs.Opaque} {
		visible := request("/v2/contributions/read", input, false, 200)
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
		if !bytes.Contains(encoded, []byte("Selected public source title")) || bytes.Contains(encoded, []byte("Private Task goal")) {
			t.Fatal("unbounded current wire", string(encoded))
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
		if written == nil {
			t.Fatal("missing publication acknowledgement")
		}
	}
	_ = request("/v2/contributions/status", statusInput, true, 200)
	request("/v2/contributions/read", refs.Read, false, 404)
	_ = request("/v2/contributions/read", refs.Read, true, 200)
}
