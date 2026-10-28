package operationscommunity_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/accountlinks"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	ops "github.com/agigalaxy-team/agigalaxy/go/internal/operationscommunity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	_, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	root, _ := filepath.Abs(filepath.Join("..", "..", ".."))
	now := time.Unix(2000000000, 0)
	clock := func() time.Time { return now }
	node := func(script, mode string, input object) object {
		t.Helper()
		cmd := exec.Command("node", script, mode)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GALAXY_GO_TEST_DATABASE_URL="+dsn)
		cmd.Stdin = bytes.NewReader(enc(input))
		b, e := cmd.Output()
		if e != nil {
			if x, ok := e.(*exec.ExitError); ok {
				t.Fatalf("original %s: %s", mode, x.Stderr)
			}
			t.Fatal(e)
		}
		var out object
		if e = json.Unmarshal(b, &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	auth := node(filepath.Join(root, "scripts/go/operations-permissions-interop.mjs"), "setup", nil)
	script := filepath.Join(root, "go/internal/operationscommunity/testdata/interop.mjs")
	oracle := func(mode string, input object) object { t.Helper(); return node(script, mode, input) }
	fixture := oracle("setup", nil)
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	endpoint, issuer := str(auth["endpoint"]), str(auth["issuer"])
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: str(obj(auth["ids"])["root"]), Issuer: issuer, Subject: "root"}}, directory{})
	if e != nil {
		t.Fatal(e)
	}
	gateway.Now = clock
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
		oracle("content-visibility", object{"kind": "post", "id": pid, "input": command})
		receiptPath := base + "content/post/" + pid + "/operations/" + str(command["operationId"])
		read := func() {
			t.Helper()
			equal(t, call("GET", receiptPath, nil), oracle("receipt", object{"operationId": command["operationId"], "scope": object{"family": "content", "kind": "post", "id": pid}}))
		}
		read()
		oracle("receipt-extra", object{"operationId": command["operationId"]})
		read()
		oracle("receipt-invalid", object{"operationId": command["operationId"]})
		read()
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
			equal(t, call("GET", contentPath, nil), oracle("content", object{"kind": "post", "id": pid}))
			replyID := str(obj(fixture["reply"])["replyId"])
			equal(t, call("GET", base+"content/reply/"+replyID, nil), oracle("content", object{"kind": "reply", "id": replyID}))
			equal(t, call("GET", base+"content?days=all", nil), oracle("contents", object{"input": object{"days": "all"}}))
		}
		checkContent()
		create := object{"operationId": uuid.NewString(), "name": "  Ｏriginal   标签 🚀  "}
		tagResult := call("POST", base+"tags", create)
		expected := oracle("tag", object{"input": create})
		delete(expected, "replayed")
		delete(tagResult, "replayed")
		equal(t, tagResult, expected)
		tagID := str(obj(tagResult["tag"])["id"])
		equal(t, call("GET", base+"tags/operations/"+str(create["operationId"]), nil), oracle("receipt", object{"operationId": create["operationId"], "scope": object{"family": "tag"}}))
		curate := object{"operationId": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 0, "topic": "arts", "pinned": true, "featured": false, "tagIds": []any{tagID}, "reason": " 原运营编排理由 "}
		curated := call("POST", contentPath+"/curation", curate)
		curatedJS := oracle("curate", object{"kind": "post", "id": pid, "input": curate})
		if curated["replayed"] != false || curatedJS["replayed"] != true {
			t.Fatal("original replay state", curated["replayed"], curatedJS["replayed"])
		}
		delete(curated, "replayed")
		delete(curatedJS, "replayed")
		equal(t, curated, curatedJS)
		checkContent()
		equal(t, call("GET", contentPath+"/operations/"+str(curate["operationId"]), nil), oracle("receipt", object{"operationId": curate["operationId"], "scope": object{"family": "content", "kind": "post", "id": pid}}))
		item := object{"kind": "post", "id": pid, "expectedVersion": 1, "expectedRevision": 0}
		preview := object{"kind": "hide", "until": now.Unix() + 300, "items": []any{item, object{"kind": "post", "id": uuid.NewString(), "expectedVersion": 1, "expectedRevision": 0}}}
		equal(t, call("POST", base+"content/visibility/preview", preview), oracle("preview", object{"input": preview}))
		batch := object{}
		for k, v := range preview {
			batch[k] = v
		}
		batch["operationId"], batch["reason"] = uuid.NewString(), " 批量当前源隐藏 "
		first := call("POST", base+"content/visibility/batch", batch)
		expected = oracle("batch", object{"input": batch})
		delete(first, "replayed")
		delete(expected, "replayed")
		equal(t, first, expected)
		previousReads := store.gets
		binary(404, true)
		if store.gets != previousReads {
			t.Fatal("hidden content fetched storage")
		}
		checkContent()
		equal(t, call("GET", base+"content/operations/"+str(batch["operationId"]), nil), oracle("receipt", object{"operationId": batch["operationId"], "scope": object{"family": "batch"}}))
		restore := object{"operationId": uuid.NewString(), "kind": "restore", "expectedVersion": 1, "expectedRevision": 1, "reason": " 恢复当前源可见 "}
		actual := call("POST", contentPath+"/visibility", restore)
		expected = oracle("content-visibility", object{"kind": "post", "id": pid, "input": restore})
		delete(actual, "replayed")
		delete(expected, "replayed")
		equal(t, actual, expected)
		checkContent()
		binary(200, true)
		disable := object{"operationId": uuid.NewString(), "expectedVersion": 1, "enabled": false}
		actual = call("POST", base+"tags/"+tagID, disable)
		expected = oracle("tag", object{"id": tagID, "input": disable})
		delete(actual, "replayed")
		delete(expected, "replayed")
		equal(t, actual, expected)
		checkContent()
		oracle("revoke", object{"versionId": post["versionId"]})
		checkContent()
		previousReads = store.gets
		binary(404, true)
		if store.gets != previousReads {
			t.Fatal("revoked source fetched storage")
		}
		return
	}

	if status, _ := request("empty", "GET", base+"reports", nil, false); status != 403 {
		t.Fatal("missing cases permission", status)
	}
	for _, v := range []struct{ mode, path, id string }{{"sections", "sections", ""}, {"section", "sections/" + sid, sid}, {"posts", "posts", ""}, {"post", "posts/" + pid, pid}, {"reports", "reports", ""}, {"report", "reports/" + rid, rid}} {
		equal(t, call("GET", base+v.path, nil), oracle(v.mode, object{"id": v.id}))
	}
	classify := object{"operationId": uuid.NewString(), "expectedVersion": 1, "category": "learning", "reason": " 原分类理由 🚀 "}
	status, _ := request("writer", "POST", base+"sections/"+sid+"/classification", classify, false)
	if status == 200 {
		t.Fatal("missing CSRF accepted")
	}
	first := call("POST", base+"sections/"+sid+"/classification", classify)
	replay := oracle("classify", object{"id": sid, "input": classify})
	delete(replay, "replayed")
	equal(t, first, replay)
	receipt := call("GET", base+"sections/"+sid+"/operations/"+str(classify["operationId"]), nil)
	equal(t, receipt, oracle("receipt", object{"operationId": classify["operationId"], "scope": object{"family": "section", "id": sid}}))
	hide := object{"operationId": uuid.NewString(), "kind": "hide", "expectedVersion": 2, "expectedVisibilityVersion": 0, "until": now.Unix() + 300, "reason": " 原限时隐藏 "}
	equal(t, call("POST", base+"sections/"+sid+"/visibility", hide), func() object {
		x := oracle("visibility", object{"id": sid, "input": hide})
		delete(x, "replayed")
		return x
	}())
	_ = receipt
	restore := object{"operationId": uuid.NewString(), "kind": "restore", "expectedVersion": 2, "expectedVisibilityVersion": 1, "reason": " 恢复可见 "}
	equal(t, call("POST", base+"sections/"+sid+"/visibility", restore), func() object {
		x := oracle("visibility", object{"id": sid, "input": restore})
		delete(x, "replayed")
		return x
	}())
	resolve := object{"operationId": uuid.NewString(), "expectedVersion": 1, "resolution": "accepted", "summary": " 原处置说明，保留在本案。 ", "restrictionAction": "hide", "hideUntil": now.Unix() + 120}
	equal(t, call("POST", base+"reports/"+rid+"/resolve", resolve), func() object {
		x := oracle("resolve", object{"id": rid, "input": resolve})
		delete(x, "replayed")
		return x
	}())
	equal(t, call("GET", base+"reports/"+rid, nil), oracle("report", object{"id": rid}))
	equal(t, call("GET", base+"reports/"+rid+"/operations/"+str(resolve["operationId"]), nil), oracle("receipt", object{"operationId": resolve["operationId"], "scope": object{"family": "case", "id": rid}}))
	var summaries int
	if e = pool.QueryRow(ctx, "SELECT count(*) FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='community-report-resolve' AND (selection ? 'summary' OR result ? 'summary')", endpoint).Scan(&summaries); e != nil || summaries != 0 {
		t.Fatal("private narrative copied to general audit", summaries, e)
	}
	status, conflict := request("writer", "GET", base+"reports/"+rid, nil, false)
	if status != 200 {
		t.Fatal(status, conflict)
	}
	equal(t, conflict, oracle("report", object{"id": rid, "who": "writer"}))
	if conflict["knownPartyConflict"] != true {
		t.Fatal("party conflict absent")
	}
	oracle("revoke", object{"versionId": post["versionId"]})
	equal(t, call("GET", base+"posts/"+pid, nil), oracle("post", object{"id": pid}))
	codes := []any{}
	for _, v := range fixture["codes"].([]any) {
		if v != "sections.classify" {
			codes = append(codes, v)
		}
	}
	oracle("permissions", object{"roleId": obj(fixture["role"])["id"], "codes": codes})
	status, out := request("writer", "POST", base+"sections/"+sid+"/classification", classify, true)
	if status != 403 {
		t.Fatal("old operation bypassed current permission", status, out)
	}
}
