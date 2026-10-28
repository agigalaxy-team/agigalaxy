package webevents

import (
	"context"
	"testing"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPublicConsumersUseOriginalQualificationReaders(t *testing.T) {
	ctx := context.Background()
	p := Principal{Kind: "device", Actor: struct{}{}, Identity: "GUID-synthetic", SubjectID: "GUID-synthetic", Endpoint: "https://events.invalid", Surface: "web"}
	var called, id, parent, kind string
	reader := func(name string) PublicRead {
		return func(_ context.Context, p Principal, object, ancestor string) (map[string]any, error) {
			called, id, parent, kind = name, object, ancestor, p.Kind
			return map[string]any{"availability": "available", "version": 1}, nil
		}
	}
	source := &PublicSources{Pool: &pgxpool.Pool{}, Endpoint: p.Endpoint, Consumers: PublicConsumers{Builder: reader("builder"), BuilderManage: reader("builder-manage"), Information: reader("information"), Choice: reader("choice"), ChoicePreferences: reader("preferences"), CIProof: reader("ci-proof"), Capsule: reader("capsule"), ForumPost: reader("post"), ForumReply: reader("reply"), ForumVersion: reader("version"), Chat: reader("chat"), Task: reader("task"), PublicTask: reader("public-task"), Project: reader("project"), Inbox: func(_ context.Context, _ Principal, notice string) error { called, id = "inbox", notice; return nil }}}
	for _, test := range []struct {
		event              Event
		reader, id, parent string
		decision           SourceDecision
	}{
		{Event{Module: "forum", SourceTable: "forum_versions_v1", Ref: map[string]any{"id": "version-1", "post_id": "post-1"}}, "version", "version-1", "post-1", Allowed},
		{Event{Module: "information", SourceTable: "forum_posts_v1", Ref: map[string]any{"id": "post-1"}}, "post", "post-1", "", Reset},
		{Event{Module: "choice-sync", SourceTable: "choice_snapshot_preferences", Ref: map[string]any{"subject_id": p.SubjectID}}, "preferences", "", "", Allowed},
		{Event{Module: "information", SourceTable: "information_watches_v2", Ref: map[string]any{"subject_id": p.SubjectID, "id": "watch-1"}}, "information", "watch-1", "", Allowed},
		{Event{Module: "ci", SourceTable: "ci_proofs_v2", Ref: map[string]any{"subject_id": p.SubjectID, "id": "proof-1"}}, "ci-proof", "proof-1", "", Allowed},
		{Event{Module: "chat", SourceTable: "chat_message_refs", Ref: map[string]any{"room_id": "room-1", "message_id": "message-1"}}, "chat", "room-1", "", Allowed},
		{Event{Module: "notifications", SourceTable: "chat_message_refs", Ref: map[string]any{"room_id": "room-1", "message_id": "message-1"}}, "inbox", "room-message:message-1", "", Reset},
	} {
		called, id, parent = "", "", ""
		decision, e := source.AuthorizeSource(ctx, p, test.event)
		if e != nil || decision != test.decision || called != test.reader || id != test.id || parent != test.parent {
			t.Fatalf("qualification %+v: decision=%v reader=%s id=%s parent=%s err=%v", test.event, decision, called, id, parent, e)
		}
	}
	official := p
	official.Kind = "official-account"
	official.SubjectID = ""
	official.AccountID = "synthetic-account"
	for _, test := range []struct {
		event  Event
		reader string
	}{
		{Event{Module: "tasks", SourceTable: "task_requests", Ref: map[string]any{"id": "task-1"}}, "public-task"},
		{Event{Module: "builders", SourceTable: "builders", Ref: map[string]any{"id": "builder-1"}}, "builder"},
		{Event{Module: "projects", SourceTable: "projects_v2", Ref: map[string]any{"id": "project-1"}}, "project"},
		{Event{Module: "capsules", SourceTable: "capsules", Ref: map[string]any{"id": "capsule-1"}}, "capsule"},
	} {
		decision, e := source.AuthorizeSource(ctx, official, test.event)
		if e != nil || decision != Allowed || called != test.reader || kind != "anonymous" {
			t.Fatalf("portal impersonated signed identity %+v %v kind=%s", test, e, kind)
		}
	}
	source.Consumers.ForumPost = nil
	event := Event{Module: "forum", SourceTable: "forum_posts_v1", Ref: map[string]any{"id": "private"}}
	decision, e := source.AuthorizeSource(ctx, p, event)
	if fault.Status(e) != 503 || decision != Denied {
		t.Fatal("missing real forum consumer was treated as available")
	}
	source.Consumers.ForumPost = func(context.Context, Principal, string, string) (map[string]any, error) {
		return nil, fault.New("not_found", 404)
	}
	event.Ref["_operation"] = "DELETE"
	decision, e = source.AuthorizeSource(ctx, p, event)
	if e != nil || decision != Reset {
		t.Fatal("deleted authorized source did not clear stale projection")
	}
	event.Ref["_operation"] = "UPDATE"
	decision, e = source.AuthorizeSource(ctx, p, event)
	if e != nil || decision != Denied {
		t.Fatal("current source authorization refusal leaked locator")
	}
}
