package operationscommunity_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	ops "github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type object = map[string]any

func obj(v any) object { o, _ := v.(map[string]any); return o }
func str(v any) string { s, _ := v.(string); return s }
func enc(v any) []byte { b, _ := protocol.Encode(v); return b }
func equal(t *testing.T, a, b any) {
	t.Helper()
	x, e := identity.Canonical(a)
	y, f := identity.Canonical(b)
	if e != nil || f != nil || !bytes.Equal(x, y) {
		t.Fatalf("original differed\nGo%s\nJS%s\n%v %v", x, y, e, f)
	}
}

type directory struct{}
type managedStore struct{ gets int }

func (*managedStore) KeyID() string                                     { return "isolated-forum-key" }
func (*managedStore) Put(context.Context, string, []byte, string) error { return nil }
func (m *managedStore) Get(context.Context, string, string, int64) ([]byte, error) {
	m.gets++
	return []byte("Original managed forum attachment."), nil
}

type scanner struct{}

func (scanner) Scan(context.Context, []byte) (map[string]any, error) {
	return object{"state": "clean"}, nil
}

func (directory) Roles(context.Context, string, string) ([]string, error) {
	return []string{"admit-admin"}, nil
}
func (d directory) RolesFresh(ctx context.Context, i, s string) ([]string, error) {
	return d.Roles(ctx, i, s)
}
func TestOriginalPortalForumOperationsAndReceipts(t *testing.T) { testOriginalPortal(t, false, false) }
func TestOriginalPublicContentGovernanceAndRetainedSources(t *testing.T) {
	testOriginalPortal(t, true, false)
}
func TestOriginalContentReceiptNestedSafeProjection(t *testing.T) { testOriginalPortal(t, false, true) }
func testOriginalPortal(t *testing.T, contentOnly, receiptOnly bool) {
	owner, _ := testsupport.PostgreSQL(t)
	ctx := context.Background()
	f := operationsfixture.Principals(t, owner, "https://permissions.example.invalid", map[string]string{"root": "R", "writer": "W", "empty": "E"})
	fixture := seedManagedForum(t, owner, f)
	pool, endpoint, gateway := f.Pool, f.Endpoint, f.Gateway
	now, clock := f.Now(), f.Now
	var e error
	forum := &community.Service{Pool: pool, Endpoint: endpoint, Now: clock}
	service := &ops.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, PrincipalWithin: gateway.LockOperationsPrincipalWithin, ReadPrincipalWithin: gateway.ReadOperationsPrincipalWithin, Forum: forum, Links: &accountlinks.Service{Endpoint: endpoint}, Now: clock}
	store := &managedStore{}
	service.Files = &community.AttachmentService{Forum: forum, Store: store, Scanner: scanner{}}
	server := httptest.NewServer(ops.Handler{Service: service})
	defer server.Close()
	request := func(who, method, path string, input object, csrf bool) (int, object) {
		t.Helper()
		var body io.Reader
		if input != nil {
			body = bytes.NewReader(enc(input))
		}
		r, e := http.NewRequest(method, server.URL+path, body)
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Origin", "https://admin.example.invalid")
		r.Header.Set("Content-Type", "application/json")
		r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat(map[string]string{"root": "R", "writer": "W", "empty": "E"}[who], 43)})
		if csrf {
			r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		}
		res, e := server.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		var out object
		if e = json.NewDecoder(res.Body).Decode(&out); e != nil {
			t.Fatal(e)
		}
		return res.StatusCode, out
	}
	call := func(method, path string, input object) object {
		t.Helper()
		status, out := request("root", method, path, input, true)
		if status != 200 {
			t.Fatalf("HTTP %d %s %v", status, path, out)
		}
		return out
	}
	section, post, report := obj(fixture["section"]), obj(fixture["post"]), obj(fixture["report"])
	sid, pid, rid := str(section["sectionId"]), str(post["postId"]), str(report["reportId"])
	base := "/v1/operations/community/"

	if receiptOnly {
		command := object{"operationId": uuid.NewString(), "kind": "hide", "expectedVersion": 1, "expectedRevision": 0, "until": now.Unix() + 300, "reason": "原收据说明"}
		call("POST", base+"content/post/"+pid+"/visibility", command)
		receiptPath := base + "content/post/" + pid + "/operations/" + str(command["operationId"])
		for _, mutation := range []string{"", "extra", "invalid"} {
			if mutation == "extra" {
				_, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET result=jsonb_set(result,'{visibility,privateNarrative}','{"body":"must not escape"}'::jsonb) WHERE endpoint=$1 AND operation_id=$2`, endpoint, command["operationId"])
			}
			if mutation == "invalid" {
				_, e = owner.Exec(ctx, `UPDATE business_admin_audit_v1 SET result=jsonb_set(result,'{visibility,hidden}','"invalid boolean"'::jsonb) WHERE endpoint=$1 AND operation_id=$2`, endpoint, command["operationId"])
			}
			if e != nil {
				t.Fatal(e)
			}
			status, result := request("root", "GET", receiptPath, nil, true)
			if mutation != "invalid" && (status != 200 || bytes.Contains(enc(result), []byte("must not escape"))) {
				t.Fatal("unsafe receipt", status, result)
			}
			if mutation == "invalid" && bytes.Contains(enc(result), []byte("invalid boolean")) {
				t.Fatal("invalid receipt escaped", status, result)
			}
		}
		return
	}

	if contentOnly {
		contentPath := base + "content/post/" + pid
		filePath := contentPath + "/attachments/" + str(fixture["attachmentId"]) + "/content"
		binary := func(want int, csrf bool) {
			t.Helper()
			r, e := http.NewRequest("POST", server.URL+filePath, strings.NewReader("{}"))
			if e != nil {
				t.Fatal(e)
			}
			r.Header.Set("Origin", "https://admin.example.invalid")
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
			if csrf {
				r.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
			}
			res, e := server.Client().Do(r)
			if e != nil {
				t.Fatal(e)
			}
			defer res.Body.Close()
			b, _ := io.ReadAll(res.Body)
			if res.StatusCode != want {
				t.Fatalf("binary HTTP%d want%d %s", res.StatusCode, want, b)
			}
			if want == 200 && (string(b) != "Original managed forum attachment." || res.Header.Get("X-Galaxy-Content-Sha256") != identity.Digest(b)) {
				t.Fatal("managed bytes integrity")
			}
		}
		binary(403, false)
		binary(200, true)
		checkContent := func() {
			t.Helper()
			for _, path := range []string{contentPath, base + "content/reply/" + str(obj(fixture["reply"])["replyId"]), base + "content?days=all"} {
				if result := call("GET", path, nil); result == nil {
					t.Fatal("missing content", path)
				}
			}
		}
		checkContent()
		initial := obj(call("GET", contentPath, nil)["content"])
		if initial["id"] != pid || initial["sourceState"] != "available" || initial["body"] != "原公开正文，当前授权。" {
			t.Fatal("current source", initial)
		}
		create := object{"operationId": uuid.NewString(), "name": "  Ｏriginal   标签 🚀  "}
		tagResult := call("POST", base+"tags", create)
		if tagResult["replayed"] != false {
			t.Fatal("first tag replay", tagResult)
		}
		tagID := str(obj(tagResult["tag"])["id"])
		if tagID == "" {
			t.Fatal(tagResult)
		}
		if replay := call("POST", base+"tags", create); replay["replayed"] != true {
			t.Fatal("tag replay", replay)
		}
		call("GET", base+"tags/operations/"+str(create["operationId"]), nil)
		curate := object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 0, "topic": "arts", "pinned": true, "featured": false, "tagIds": []any{tagID}, "reason": " 原运营编排理由 "}
		curated := call("POST", contentPath+"/curation", curate)
		if curated["replayed"] != false {
			t.Fatal("curation first", curated)
		}
		if replay := call("POST", contentPath+"/curation", curate); replay["replayed"] != true {
			t.Fatal("curation replay", replay)
		}
		checkContent()
		call("GET", contentPath+"/operations/"+str(curate["operationId"]), nil)
		item := object{"kind": "post", "id": pid, "expectedVersion": 1, "expectedRevision": 0}
		preview := object{"kind": "hide", "until": now.Unix() + 300, "items": []any{item, object{"kind": "post", "id": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 0}}}
		call("POST", base+"content/visibility/preview", preview)
		batch := object{}
		for k, v := range preview {
			batch[k] = v
		}
		batch["operationId"], batch["reason"] = uuid.NewString(), " 批量当前源隐藏 "
		first := call("POST", base+"content/visibility/batch", batch)
		if first["replayed"] != false {
			t.Fatal("batch first", first)
		}
		if replay := call("POST", base+"content/visibility/batch", batch); replay["replayed"] != true {
			t.Fatal("batch replay", replay)
		}
		previousReads := store.gets
		binary(404, true)
		if store.gets != previousReads {
			t.Fatal("hidden content fetched storage")
		}
		checkContent()
		call("GET", base+"content/operations/"+str(batch["operationId"]), nil)
		restore := object{"operationId": uuid.NewString(), "kind": "restore", "expectedVersion": 1, "expectedRevision": 1, "reason": " 恢复当前源可见 "}
		actual := call("POST", contentPath+"/visibility", restore)
		if actual["replayed"] != false {
			t.Fatal("restore first", actual)
		}
		if replay := call("POST", contentPath+"/visibility", restore); replay["replayed"] != true {
			t.Fatal("restore replay", replay)
		}
		checkContent()
		binary(200, true)
		disable := object{"operationId": uuid.NewString(), "expectedVersion": 1, "enabled": false}
		actual = call("POST", base+"tags/"+tagID, disable)
		if actual["replayed"] != false {
			t.Fatal("tag update first", actual)
		}
		if replay := call("POST", base+"tags/"+tagID, disable); replay["replayed"] != true {
			t.Fatal("tag update replay", replay)
		}
		checkContent()
		if _, e = owner.Exec(ctx, `UPDATE forum_permissions_v1 SET revoked_at=$2 WHERE object_id=$1`, post["versionId"], now); e != nil {
			t.Fatal(e)
		}
		checkContent()
		previousReads = store.gets
		binary(404, true)
		if store.gets != previousReads {
			t.Fatal("revoked source fetched storage")
		}
		revoked := obj(call("GET", contentPath, nil)["content"])
		if revoked["sourceState"] != "unavailable" || revoked["body"] != nil {
			t.Fatal("revoked source exposed", revoked)
		}
		return
	}

	if status, _ := request("empty", "GET", base+"reports", nil, false); status != 403 {
		t.Fatal("missing cases permission", status)
	}
	for _, v := range []struct{ mode, path, id string }{{"sections", "sections", ""}, {"section", "sections/" + sid, sid}, {"posts", "posts", ""}, {"post", "posts/" + pid, pid}, {"reports", "reports", ""}, {"report", "reports/" + rid, rid}} {
		call("GET", base+v.path, nil)
	}
	classify := object{"operationId": uuid.NewString(), "expectedVersion": 1, "category": "learning", "reason": " 原分类理由 🚀 "}
	status, _ := request("writer", "POST", base+"sections/"+sid+"/classification", classify, false)
	if status == 200 {
		t.Fatal("missing CSRF accepted")
	}
	first := call("POST", base+"sections/"+sid+"/classification", classify)
	if first == nil {
		t.Fatal("missing classification")
	}
	call("GET", base+"sections/"+sid+"/operations/"+str(classify["operationId"]), nil)
	hide := object{"operationId": uuid.NewString(), "kind": "hide", "expectedVersion": 2, "expectedVisibilityVersion": 0, "until": now.Unix() + 300, "reason": " 原限时隐藏 "}
	call("POST", base+"sections/"+sid+"/visibility", hide)
	restore := object{"operationId": uuid.NewString(), "kind": "restore", "expectedVersion": 2, "expectedVisibilityVersion": 1, "reason": " 恢复可见 "}
	call("POST", base+"sections/"+sid+"/visibility", restore)
	resolve := object{"operationId": uuid.NewString(), "expectedVersion": 1, "resolution": "accepted", "summary": " 原处置说明，保留在本案。 ", "restrictionAction": "hide", "hideUntil": now.Unix() + 120}
	call("POST", base+"reports/"+rid+"/resolve", resolve)
	call("GET", base+"reports/"+rid, nil)
	call("GET", base+"reports/"+rid+"/operations/"+str(resolve["operationId"]), nil)
	var summaries int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='community-report-resolve' AND (selection ? 'summary' OR result ? 'summary')", endpoint).Scan(&summaries); e != nil || summaries != 0 {
		t.Fatal("private narrative copied to general audit", summaries, e)
	}
	status, conflict := request("writer", "GET", base+"reports/"+rid, nil, false)
	if status != 200 {
		t.Fatal(status, conflict)
	}
	if conflict["knownPartyConflict"] != true {
		t.Fatal("party conflict absent")
	}
	if _, e = owner.Exec(ctx, `UPDATE forum_permissions_v1 SET revoked_at=$2 WHERE object_id=$1`, post["versionId"], now); e != nil {
		t.Fatal(e)
	}
	revokedPost := call("GET", base+"posts/"+pid, nil)
	if revokedPost["sourceState"] != "unavailable" || revokedPost["title"] != nil {
		t.Fatal("revoked post source exposed", revokedPost)
	}
	codes := []any{}
	for _, v := range fixture["codes"].([]any) {
		if v != "sections.classify" {
			codes = append(codes, v)
		}
	}
	if _, e = f.Permissions.SaveRole(ctx, f.Root, object{"operationId": uuid.NewString(), "id": obj(fixture["role"])["id"], "expectedVersion": 1, "name": "Forum operator", "description": "Synthetic forum authority", "enabled": true, "permissions": codes}); e != nil {
		t.Fatal(e)
	}
	status, out := request("writer", "POST", base+"sections/"+sid+"/classification", classify, true)
	if status != 403 {
		t.Fatal("old operation bypassed current permission", status, out)
	}
}
