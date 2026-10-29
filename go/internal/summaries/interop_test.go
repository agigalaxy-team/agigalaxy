package summaries

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/chat"
	"github.com/agigalaxy-team/agigalaxy/go/internal/databaseschema"
	"github.com/agigalaxy-team/agigalaxy/go/internal/deviceauth"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/operationsrules"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/accountlinkfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/chatarchivefixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/deviceauthfixture"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/devicefixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOwnerSummaryCurrentMetadataAndReceipt(t *testing.T) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	if _, e := databaseschema.Migrate(ctx, owner, []string{"api", "worker"}); e != nil {
		t.Fatal(e)
	}
	a := deviceauthfixture.New(t, owner, t.TempDir(), []string{"binding", "consent", "history"})
	b := deviceauthfixture.New(t, owner, t.TempDir(), []string{"binding", "consent", "history"})
	links := accountlinkfixture.New(t, owner, a.Service)
	links.Link(a, "summary-owner")
	links.Link(b, "summary-author")
	endpoint := devicefixture.Endpoint
	now := func() time.Time { return time.Unix(devicefixture.Now, 0) }
	if _, e := owner.Exec(ctx, `INSERT INTO operations_product_rules_v1(endpoint,policy_key,version,policy,source,created_at) VALUES($1,'business-controls',1,$2,'configured-baseline',$3)`, endpoint, operationsrules.EmptyControls(), now()); e != nil {
		t.Fatal(e)
	}
	cfg := owner.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	archive := chatarchivefixture.New(t)
	transport, e := chat.NewComponentTransport("xmpp://"+archive.Listener.Addr().String(), "gateway.example.invalid", "rooms.example.invalid", chatarchivefixture.Secret, 300*time.Millisecond)
	if e != nil {
		t.Fatal(e)
	}
	if e = transport.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer transport.Stop()
	devices := &deviceauth.Service{Pool: pool, Endpoint: endpoint, Now: now}
	rooms := &chat.Service{Pool: pool, Endpoint: endpoint, Devices: devices, Links: links.Registry, Transport: transport, Rules: &businessrules.Service{Endpoint: endpoint, Now: now}, Now: now}
	actor, peer := chat.Actor{Device: &a.Actor}, chat.Actor{Device: &b.Actor}
	encode := func(v any) []byte { raw, _ := json.Marshal(v); return raw }
	room := uuid.NewString()
	created, e := rooms.Create(ctx, actor, encode(Object{"roomId": room, "operationId": uuid.NewString(), "title": "Explicit summary source room"}))
	if e != nil {
		t.Fatal(e)
	}
	decision := uuid.NewString()
	if _, e = rooms.Propose(ctx, actor, room, encode(Object{"decisionId": decision, "expectedRevision": created["revision"], "action": "invite", "targetSubjectId": b.Actor.SubjectID})); e != nil {
		t.Fatal(e)
	}
	if _, e = rooms.Accept(ctx, peer, room, encode(Object{"decisionId": decision})); e != nil {
		t.Fatal(e)
	}
	sent, e := rooms.Send(ctx, peer, room, encode(Object{"clientMessageId": uuid.NewString(), "text": "Original selected message, not a summary model input"}))
	if e != nil {
		t.Fatal(e)
	}
	message := str(sent, "messageId")
	s, e := New(pool, endpoint, devices, now)
	if e != nil {
		t.Fatal(e)
	}
	s.Source = rooms.SummarySourceWithin
	s.ErasureSource = rooms.SummaryErasureSourceWithin
	handler := Handler{Service: s}
	request := func(action string, input Object, other bool, status int) Object {
		t.Helper()
		r := httptest.NewRequest("POST", "/v2/personal-summaries/"+action, bytes.NewReader(encode(input)))
		r.Header.Set("Content-Type", "application/json")
		token := a.Credential
		if other {
			token = b.Credential
		}
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s HTTP%d %s", action, w.Code, w.Body.String())
		}
		var out Object
		if e := json.Unmarshal(w.Body.Bytes(), &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	summary := uuid.NewString()
	ref := Object{"messageId": message, "revision": 1}
	base := Object{"versionId": uuid.NewString(), "summaryId": summary, "roomId": room, "baseRevision": 0, "preferenceRevision": 1, "content": Object{"generator": Object{"kind": "manual"}, "coverage": Object{"fromSequence": "0", "throughSequence": "90071992547409930000", "complete": true}, "fragments": []any{Object{"id": uuid.NewString(), "kind": "derived", "text": "Owner-selected derived fragment", "sourceRefs": []any{ref}}, Object{"id": uuid.NewString(), "kind": "personal-note", "text": "Independent owner note", "sourceRefs": []any{}}}, "keyMessageRefs": []any{ref}}}
	conflict := Object{}
	for k, v := range base {
		conflict[k] = v
	}
	conflict["versionId"] = uuid.NewString()
	conflictContent := Object{}
	for k, v := range object(base["content"]) {
		conflictContent[k] = v
	}
	conflictContent["generator"] = Object{"kind": "user-model", "label": "Owner-selected existing model output"}
	conflict["content"] = conflictContent
	resolve := Object{}
	for k, v := range base {
		resolve[k] = v
	}
	resolve["versionId"], resolve["baseRevision"], resolve["resolveVersionIds"] = uuid.NewString(), 1, []any{conflict["versionId"]}
	get := Object{"summaryId": summary}
	source := Object{"roomId": room, "refs": []any{ref}}
	request("preferences/read", Object{}, false, 200)
	request("preferences/save", Object{"expectedRevision": 0, "endpoint": endpoint, "enabled": true}, false, 200)
	request("sources", source, false, 200)
	for i, put := range []Object{base, conflict, resolve} {
		out := request("put", put, false, 200)
		if out["syncState"] != []string{"synced", "conflict", "synced"}[i] {
			t.Fatal("summary conflict state", out)
		}
		replay := request("put", put, false, 200)
		if replay["replayed"] != true {
			t.Fatal("summary replay", replay)
		}
		receipt := Object{"summaryId": summary, "versionId": put["versionId"]}
		if request("receipt", receipt, false, 200)["state"] != "committed" || request("receipt", receipt, true, 200)["state"] != "absent" {
			t.Fatal("summary owner receipt")
		}
	}
	request("list", Object{}, false, 200)
	if request("get", get, true, 200)["current"] != nil {
		t.Fatal("other owner saw summary")
	}
	second := Object{}
	for k, v := range base {
		second[k] = v
	}
	second["summaryId"], second["versionId"] = uuid.NewString(), uuid.NewString()
	request("put", second, false, 200)
	edit := Object{"operationId": uuid.NewString(), "expectedRevision": 1, "text": "Author corrected current message"}
	archive.Mu.Lock()
	archive.LoseNextEdit = true
	archive.Mu.Unlock()
	if _, e = rooms.Edit(ctx, peer, room, message, encode(edit)); fault.Code(e) != "chat_delivery_unknown" {
		t.Fatal("expected unknown edit receipt", e)
	}
	temporary := request("get", get, false, 200)
	version := object(temporary["current"])
	if version["sourcesTemporarilyUnavailable"] != true || len(array(object(version["content"])["fragments"])) != 1 {
		t.Fatal("temporary projection", temporary)
	}
	var retained int
	if e = pool.QueryRow(ctx, "SELECT jsonb_array_length(content->'fragments') FROM personal_summary_versions WHERE version_id=$1", resolve["versionId"]).Scan(&retained); e != nil || retained != 2 {
		t.Fatal("temporary source erased retained body", retained, e)
	}
	maintenance, e := s.PurgeInvalidSources(ctx, "", 20)
	if e != nil || number(maintenance["changed"]) != 0 {
		t.Fatal("temporary source pass erased fragments", maintenance, e)
	}
	if _, e = rooms.Edit(ctx, peer, room, message, encode(edit)); e != nil {
		t.Fatal("reconcile exact edit", e)
	}
	permanent := request("get", get, false, 200)
	if object(permanent["current"])["sourcesTemporarilyUnavailable"] != false {
		t.Fatal("permanent source change treated as temporary", permanent)
	}
	if e = pool.QueryRow(ctx, "SELECT jsonb_array_length(content->'fragments') FROM personal_summary_versions WHERE version_id=$1", resolve["versionId"]).Scan(&retained); e != nil || retained != 1 {
		t.Fatal("permanent old revision retained", retained, e)
	}
	maintenance, e = s.PurgeInvalidSources(ctx, "", 20)
	if e != nil || number(maintenance["changed"]) != 1 {
		t.Fatal("owner replica maintenance", maintenance, e)
	}
	if e = pool.QueryRow(ctx, "SELECT jsonb_array_length(content->'fragments') FROM personal_summary_versions WHERE version_id=$1", second["versionId"]).Scan(&retained); e != nil || retained != 1 {
		t.Fatal("trusted metadata cleanup", retained, e)
	}
	receipt := Object{"summaryId": summary, "versionId": base["versionId"]}
	request("receipt", receipt, false, 200)
	request("delete", Object{"summaryId": summary, "expectedRevision": 2}, false, 200)
	if request("receipt", receipt, false, 200)["state"] != "committed" {
		t.Fatal("deletion lost original receipt")
	}
}
