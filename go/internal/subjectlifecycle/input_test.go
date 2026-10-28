package subjectlifecycle

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestStrictSelectionsAndRetentionBoundaries(t *testing.T) {
	s := &Service{Now: func() time.Time { return time.Unix(2000000000, 0) }}
	id := uuid.NewString()
	version := uuid.NewString()
	for _, input := range []CreateInput{{ID: id, Datasets: []string{"identity", "identity"}}, {ID: id, Datasets: []string{"../private"}}, {ID: id, Datasets: []string{"authorized-views"}}, {ID: id, Datasets: []string{"identity"}, Views: []View{{Kind: "project", ID: version}}}, {ID: id, Datasets: []string{"authorized-views"}, Views: []View{{Kind: "forum-post-version", ID: version}}}} {
		if e := s.validateCreate(&input); fault.Status(e) != 400 {
			t.Fatal("invalid selection accepted", input, e)
		}
	}
	for _, raw := range []string{`{"id":"` + id + `","views":[{"kind":"case","id":"` + version + `","taskId":null}]}`, `{"id":"` + id + `","datasets":null}`, `{"id":"` + id + `","extra":true}`} {
		var input CreateInput
		if e := strictBody([]byte(raw), &input, "id", "datasets", "views"); fault.Status(e) != 400 {
			t.Fatal("strict input accepted", e)
		}
	}
	if len(catalog.Datasets) != len(catalog.Sources) || len(catalog.Datasets) != 134 || len(viewKinds) != len(catalog.ViewScopes) || viewKinds[0] != "forum-post-version" {
		t.Fatal("original catalog/order changed")
	}
	now := s.now()
	cases := []struct {
		name    string
		item    Object
		expired bool
		flag    string
	}{
		{"qualification-request-events", Object{"expires_at": time.Unix(now, 0).UTC().Format(time.RFC3339), "payload_text": "private"}, true, "content_expired"},
		{"qualification-request-events", Object{"expires_at": time.Unix(now+1, 0).UTC().Format(time.RFC3339), "payload_text": "private"}, false, "content_expired"},
		{"hub-events-v2", Object{"kind": "intake-offer", "expires_at": now, "payload_text": "private"}, true, "contentExpired"},
		{"task-events", Object{"kind": "invite", "created_at": time.Unix(now-90*86400, 0).UTC().Format(time.RFC3339), "payload_text": "private"}, true, "content_expired"},
		{"task-events", Object{"kind": "accept-delivery", "created_at": time.Unix(now-90*86400, 0).UTC().Format(time.RFC3339), "payload_text": "private"}, false, "content_expired"},
	}
	for _, test := range cases {
		item, e := s.transform(context.Background(), nil, Actor{}, test.name, test.item)
		if e != nil {
			t.Fatal(e)
		}
		expired, _ := item[test.flag].(bool)
		if expired != test.expired || test.expired && text(item["payload_text"]) != "" {
			t.Fatalf("retention %s: %v", test.name, item)
		}
	}
	if _, e := s.transform(context.Background(), nil, Actor{}, "forum-events", Object{"payload_text": "private"}); fault.Status(e) != 503 {
		t.Fatal("missing source reader released text")
	}
	// Exported SHA fields bind the precise serialization sent to original clients.
	raw, e := encoded(struct {
		Version int    `json:"version"`
		Text    string `json:"text"`
	}{1, "x\u2028y"})
	if e != nil || !json.Valid(raw) {
		t.Fatal(e)
	}
	for _, value := range []string{"x\u2028y", `x\u2028y`, "x\u2029y", `x\\u2029y`} {
		raw, e := encoded(struct {
			Text string `json:"text"`
		}{value})
		var decoded struct {
			Text string `json:"text"`
		}
		if e != nil || json.Unmarshal(raw, &decoded) != nil || decoded.Text != value {
			t.Fatal("JSON encoding changed exact payload text")
		}
	}
}

func TestForumConsumersUseExactStoredScopeAndSelector(t *testing.T) {
	s := &Service{}
	actor := Actor{}
	actor.SubjectID = "GUID" + "0000000000000000000000000000"
	versionCalls, replyCalls, permissionCalls := 0, 0, 0
	s.ConnectForum(ForumConsumers{
		ReadVersion: func(_ context.Context, _ pgx.Tx, a Actor, post, version string) (Object, error) {
			versionCalls++
			if a.SubjectID != actor.SubjectID || post != "stored-post" || version != "stored-version" {
				t.Fatal("forum version selector changed")
			}
			return Object{"availability": "available"}, nil
		},
		ReadReply: func(_ context.Context, _ pgx.Tx, a Actor, reply string) (Object, error) {
			replyCalls++
			if a.SubjectID != actor.SubjectID || reply != "stored-reply" {
				t.Fatal("forum reply selector changed")
			}
			return Object{"availability": "unavailable"}, nil
		},
		PermissionAllowed: func(_ context.Context, _ pgx.Tx, id, viewer, hash, visibility string) (bool, error) {
			permissionCalls++
			if id != "stored-permission" || viewer != actor.SubjectID || hash != "stored-hash" {
				t.Fatal("permission selector changed")
			}
			return visibility == "Private", nil
		},
	})
	for _, test := range []struct {
		dataset, kind string
		allowed       bool
	}{{"forum-events", "publish-version", true}, {"forum-events", "create-reply", false}, {"forum-events", "revoke-permission", false}, {"forum-governance-events", "report", true}} {
		item, e := s.transform(context.Background(), nil, actor, test.dataset, Object{"payload_text": "private bytes", "kind": test.kind, "post_id": "stored-post", "version_id": "stored-version", "reply_id": "stored-reply", "permission_id": "stored-permission", "payload_hash": "stored-hash"})
		if e != nil {
			t.Fatal(e)
		}
		if item["contentAvailable"] != test.allowed || !test.allowed && text(item["payload_text"]) != "" {
			t.Fatal("forum current authorization was bypassed")
		}
	}
	if versionCalls != 1 || replyCalls != 1 || permissionCalls != 2 {
		t.Fatal("forum readers not selected by original event kind")
	}
}
