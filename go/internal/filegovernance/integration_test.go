package filegovernance_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/agigalaxy-team/agigalaxy/go/internal/attachments"
	"github.com/agigalaxy-team/agigalaxy/go/internal/community"
	files "github.com/agigalaxy-team/agigalaxy/go/internal/filegovernance"
	"github.com/agigalaxy-team/agigalaxy/go/internal/identity"
	"github.com/agigalaxy-team/agigalaxy/go/internal/protocol"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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
	left, e := identity.Canonical(a)
	right, f := identity.Canonical(b)
	if e != nil || f != nil || !bytes.Equal(left, right) {
		t.Fatalf("original projection differed\nGo %s\nJS %s errors %v %v", left, right, e, f)
	}
}

type directory struct{}

func (directory) Roles(context.Context, string, string) ([]string, error) {
	return []string{"admit-admin"}, nil
}
func (d directory) RolesFresh(ctx context.Context, issuer, subject string) ([]string, error) {
	return d.Roles(ctx, issuer, subject)
}

type fixtureStore struct {
	dir             string
	loseErase       bool
	erasures, heads int
}

func (f *fixtureStore) KeyID() string { return "isolated-managed-key" }
func (f *fixtureStore) name(key string) string {
	return filepath.Join(f.dir, base64.RawURLEncoding.EncodeToString([]byte(key)))
}
func (f *fixtureStore) Put(_ context.Context, key string, b []byte, hash string) error {
	return os.WriteFile(f.name(key), b, 0600)
}
func (f *fixtureStore) Get(_ context.Context, key, kid string, size int64) ([]byte, error) {
	return os.ReadFile(f.name(key))
}
func (f *fixtureStore) Head(_ context.Context, key, kid string) (*attachments.Head, error) {
	f.heads++
	b, e := os.ReadFile(f.name(key))
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	hash := attachments.Digest(b)
	return &attachments.Head{Size: int64(len(b)), SHA256: &hash}, nil
}
func (f *fixtureStore) Erase(_ context.Context, key string) error {
	f.erasures++
	e := os.Remove(f.name(key))
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	if f.loseErase {
		f.loseErase = false
		return io.ErrUnexpectedEOF
	}
	return nil
}

type scanner struct{}

func (scanner) Scan(context.Context, []byte) (object, error) {
	return object{"state": "clean", "checkedAt": 2000000000}, nil
}
func TestFileGovernanceCurrentPortalOriginalProjectionAndApprovedUnknownCleanup(t *testing.T) {
	testCurrentFileGovernance(t, false)
}
func TestSharedBusinessDomainOriginalPortalFileReceipt(t *testing.T) {
	testCurrentFileGovernance(t, true)
}
func testCurrentFileGovernance(t *testing.T, receiptOnly bool) {
	owner, dsn := testsupport.PostgreSQL(t)
	ctx := context.Background()
	store := &fixtureStore{dir: t.TempDir()}
	now := time.Unix(2000000000, 0)
	clock := func() time.Time { return now }
	f := operationsfixture.Principals(t, owner, "https://permissions.example.invalid", map[string]string{"root": "R", "writer": "W", "empty": "E"})
	f.Gateway.Now = clock
	f.Permissions.Now = clock
	fixture := seedManagedFiles(t, owner, f, store)
	rows := map[string]object{}
	for _, value := range fixture["rows"].([]any) {
		r := obj(value)
		rows[str(r["kind"])] = r
	}
	pool, endpoint, gateway := f.Pool, f.Endpoint, f.Gateway
	var e error
	setPermissions := func(codes any) {
		t.Helper()
		var version int
		if e = owner.QueryRow(ctx, `SELECT version FROM operations_business_roles_v1 WHERE endpoint=$1 AND id=$2`, endpoint, obj(fixture["role"])["id"]).Scan(&version); e != nil {
			t.Fatal(e)
		}
		if _, e = f.Permissions.SaveRole(ctx, f.Root, object{"operationId": uuid.NewString(), "id": obj(fixture["role"])["id"], "expectedVersion": version, "name": "File maintainer", "description": "Synthetic file authority", "enabled": true, "permissions": codes}); e != nil {
			t.Fatal(e)
		}
	}
	forum := &community.Service{Pool: pool, Endpoint: endpoint, Now: clock}
	forumFiles := &community.AttachmentService{Forum: forum, Store: store, Scanner: scanner{}, Policy: attachments.DefaultPolicy()}
	service := &files.Service{Pool: pool, Endpoint: endpoint, Authority: gateway, StoredAuthority: gateway.StoredOperators(), PrincipalWithin: gateway.LockOperationsPrincipalWithin, Forum: forumFiles.GovernanceAdapter(), Now: clock}
	server := httptest.NewServer(files.Handler{Service: service})
	defer server.Close()
	request := func(who, method, path string, input object, csrf bool) (int, object) {
		t.Helper()
		var reader io.Reader
		if input != nil {
			reader = bytes.NewReader(enc(input))
		}
		req, e := http.NewRequest(method, server.URL+path, reader)
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Origin", "https://admin.example.invalid")
		req.Header.Set("Content-Type", "application/json")
		cookie := map[string]string{"root": "R", "writer": "W", "empty": "E"}[who]
		req.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat(cookie, 43)})
		if csrf {
			req.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
		}
		res, e := server.Client().Do(req)
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
	check := func(status int, out object) {
		t.Helper()
		if status != 200 {
			t.Fatalf("management HTTP%d %v", status, out)
		}
	}
	status, result := request("empty", "GET", "/v1/operations/files", nil, false)
	if status != 403 {
		t.Fatal("reader with no file permission", status, result)
	}
	for _, path := range []string{"/v1/operations/files", "/v1/operations/files/summary"} {
		status, result = request("writer", "GET", path, nil, false)
		check(status, result)
		if result == nil {
			t.Fatal("missing file listing", path)
		}
	}
	get := func(id string) object {
		t.Helper()
		status, result := request("writer", "GET", "/v1/operations/files/forum/"+id, nil, false)
		check(status, result)
		if result["id"] != id || result["kind"] != "forum" || result["contentAvailable"] != false {
			t.Fatal("unexpected managed file projection", result)
		}
		return result
	}
	current := get(str(rows["available"]["id"]))
	scan := get(str(rows["scan"]["id"]))
	retry := object{"operationId": uuid.NewString(), "kind": "scan", "expectedVersion": scan["version"], "reason": "按原失败记录重试扫描"}
	path := "/v1/operations/files/forum/" + str(rows["scan"]["id"]) + "/retry"
	status, result = request("writer", "POST", path, retry, false)
	if status != 403 {
		t.Fatal("missing current CSRF accepted", status, result)
	}
	status, result = request("writer", "POST", path, retry, true)
	check(status, result)
	if result["file"] == nil {
		t.Fatal("missing retried file", result)
	}
	status, result = request("writer", "POST", path, retry, true)
	check(status, result)
	if result["replayed"] != true {
		t.Fatal("scan original operation replay", result)
	}
	if receiptOnly {
		changed := object{}
		for k, v := range retry {
			changed[k] = v
		}
		changed["reason"] = "不能替换原操作理由"
		status, result = request("writer", "POST", path, changed, true)
		if status != 409 || result["error"] != "business_admin_operation_conflict" {
			t.Fatal("same original operation accepted a changed selection", status, result)
		}
		codes := []any{}
		for _, v := range fixture["codes"].([]any) {
			if v != "files.scan.retry" {
				codes = append(codes, v)
			}
		}
		setPermissions(codes)
		status, result = request("writer", "POST", path, retry, true)
		if status != 403 {
			t.Fatal("replay ignored current human permission", status, result)
		}
		return
	}
	accessPath := "/v1/operations/files/forum/" + str(rows["available"]["id"]) + "/access"
	stop := object{"operationId": uuid.NewString(), "action": "stop", "expectedVersion": current["version"], "expectedRevision": 0, "reason": "原文件停止访问核验", "until": now.Unix() + 1200}
	status, result = request("writer", "POST", accessPath, stop, true)
	check(status, result)
	if obj(obj(result["file"])["access"])["stopped"] != true {
		t.Fatal("stop not applied", result)
	}
	status, op := request("writer", "GET", "/v1/operations/files/access/operations/"+str(stop["operationId"]), nil, false)
	check(status, op)
	if op == nil {
		t.Fatal("missing access receipt")
	}
	restore := object{"operationId": uuid.NewString(), "action": "restore", "expectedVersion": current["version"], "expectedRevision": 1, "reason": "原来源仍有效恢复访问"}
	status, result = request("writer", "POST", accessPath, restore, true)
	check(status, result)
	if obj(obj(result["file"])["access"])["stopped"] != false {
		t.Fatal("restore not applied", result)
	}
	status, candidates := request("writer", "GET", "/v1/operations/files/cleanup/candidates", nil, false)
	check(status, candidates)
	candidate := obj(candidates["items"].([]any)[0])
	if candidate["id"] != rows["expired"]["id"] || candidate["eligible"] != true {
		t.Fatal("concrete operational eligibility", candidates)
	}
	create := object{"operationId": uuid.NewString(), "items": []any{object{"kind": "forum", "id": candidate["id"], "expectedVersion": candidate["expectedVersion"]}}, "reason": "只清理列明的原到期文件"}
	status, result = request("writer", "POST", "/v1/operations/files/cleanup/plans", create, true)
	check(status, result)
	plan := obj(result["plan"])
	planID := str(plan["id"])
	if planID == "" {
		t.Fatal("missing plan", plan)
	}
	status, result = request("writer", "POST", "/v1/operations/files/cleanup/plans", create, true)
	check(status, result)
	if result["replayed"] != true || str(result["planId"]) != planID {
		t.Fatal("plan exact operation replay", result)
	}
	status, result = request("writer", "POST", "/v1/operations/files/cleanup/plans/"+planID+"/approve", object{"operationId": uuid.NewString(), "expectedRevision": plan["revision"]}, true)
	check(status, result)
	codes := []string{}
	for _, value := range fixture["codes"].([]any) {
		if str(value) != "files.cleanup.approve" {
			codes = append(codes, str(value))
		}
	}
	setPermissions(codes)
	workerCfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		t.Fatal(e)
	}
	workerCfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, e := c.Exec(ctx, "SET ROLE galaxy_evidence_worker")
		return e
	}
	worker, e := pgxpool.NewWithConfig(ctx, workerCfg)
	if e != nil {
		t.Fatal(e)
	}
	defer worker.Close()
	workerService := *service
	workerService.Pool = worker
	outcome, e := workerService.ProcessApproved(ctx, 1)
	if e != nil || outcome["processed"] != 1 || store.heads != 0 || store.erasures != 0 {
		t.Fatal("worker accepted stale approver permission", outcome, e, store.heads, store.erasures)
	}
	setPermissions(fixture["codes"])
	now = now.Add(31 * time.Second)
	store.loseErase = true
	outcome, e = workerService.ProcessApproved(ctx, 1)
	if e != nil || outcome["processed"] != 1 || store.erasures != 1 {
		t.Fatal("lost deletion ACK", outcome, e, store.erasures)
	}
	var purged bool
	if e = owner.QueryRow(ctx, "SELECT purged_at IS NOT NULL FROM forum_attachments_v1 WHERE id=$1", candidate["id"]).Scan(&purged); e != nil || !purged {
		t.Fatal("absent HEAD after lost ACK did not confirm removal", e, purged)
	}
	now = now.Add(31 * time.Second)
	outcome, e = workerService.ProcessApproved(ctx, 1)
	if e != nil || outcome["processed"] != 0 || store.erasures != 1 {
		t.Fatal("unknown retry must confirm exact original object absent", outcome, e, store.erasures)
	}
	status, result = request("writer", "GET", "/v1/operations/files/cleanup/plans/"+planID, nil, false)
	check(status, result)

	if result["state"] != "completed" || obj(result["counts"])["removed"] != float64(1) {
		t.Fatal("concrete removal receipt", result)
	}
	// Cancellation is an original decision on a fixed plan, never an erase.
	if _, e = owner.Exec(ctx, "UPDATE forum_attachments_v1 SET expires_at=$2 WHERE id=$1", rows["available"]["id"], now.Add(-time.Second)); e != nil {
		t.Fatal(e)
	}
	for range 2 {
		status, candidates = request("writer", "GET", "/v1/operations/files/cleanup/candidates", nil, false)
		check(status, candidates)
		candidate = obj(candidates["items"].([]any)[0])
		create = object{"operationId": uuid.NewString(), "items": []any{object{"kind": "forum", "id": candidate["id"], "expectedVersion": candidate["expectedVersion"]}}, "reason": "本批可审阅的取消计划"}
		status, result = request("writer", "POST", "/v1/operations/files/cleanup/plans", create, true)
		check(status, result)
		plan = obj(result["plan"])
		planID = str(plan["id"])
		operation := uuid.NewString()
		decision := object{"operationId": operation, "expectedRevision": plan["revision"]}
		status, result = request("writer", "POST", "/v1/operations/files/cleanup/plans/"+planID+"/cancel", decision, true)
		check(status, result)
		if obj(result["plan"]) == nil {
			t.Fatal("missing cancelled plan", result)
		}
		status, result = request("writer", "GET", "/v1/operations/files/cleanup/operations/"+operation, nil, false)
		check(status, result)
		if result == nil {
			t.Fatal("missing cancellation receipt")
		}
	}
	outcome, e = workerService.ProcessApproved(ctx, 1)
	if e != nil || outcome["processed"] != 0 || store.erasures != 1 {
		t.Fatal("cancelled plans executed", outcome, e, store.erasures)
	}
}
