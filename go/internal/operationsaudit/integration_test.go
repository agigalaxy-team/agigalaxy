package operationsaudit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/agigalaxy-team/agigalaxy/go/internal/access"
	"github.com/agigalaxy-team/agigalaxy/go/internal/businessadmin"
	"github.com/agigalaxy-team/agigalaxy/go/internal/fault"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport"
	"github.com/agigalaxy-team/agigalaxy/go/internal/testsupport/operationsfixture"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type directory struct{}

func (directory) Roles(context.Context, string, string) ([]string, error) {
	return []string{"admit-admin"}, nil
}
func (d directory) RolesFresh(ctx context.Context, i, s string) ([]string, error) {
	return d.Roles(ctx, i, s)
}
func TestActualAuditCursorSnapshotSafeSearchAndAccountReadAttribution(t *testing.T) {
	ownerPool, _ := testsupport.PostgreSQL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 85*time.Second)
	defer cancel()
	fixture := operationsfixture.New(t, ownerPool).Data
	endpoint, issuer, rootID := str(fixture["endpoint"]), str(fixture["issuer"]), str(obj(fixture["ids"])["root"])
	cfg := ownerPool.Config()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error { _, e := c.Exec(ctx, "SET ROLE galaxy_api"); return e }
	pool, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	gateway, e := access.New(pool, access.Config{Endpoint: endpoint, WebsiteOrigin: "https://web.example.invalid", AdminOrigin: "https://admin.example.invalid", AccountIssuer: "https://public.example.invalid/realms/public", OperatorIssuer: issuer, AccountScope: strings.Repeat("a", 64), OperatorConfiguration: strings.Repeat("b", 64), AdministratorRole: "admit-admin", ReaderRole: "admit-reader", Root: &access.Root{OperatorID: rootID, Issuer: issuer, Subject: "root"}}, directory{})
	if e != nil {
		t.Fatal(e)
	}
	clock := int64(2000000000)
	now := func() time.Time { return time.Unix(clock, 0) }
	gateway.Now = now
	request := httptest.NewRequest("GET", "https://admin.example.invalid/v1/operations/audit", nil)
	request.Header.Set("Origin", "https://admin.example.invalid")
	request.Header.Set("X-Galaxy-Operator-CSRF", strings.Repeat("C", 43))
	request.AddCookie(&http.Cookie{Name: "__Host-galaxy-operator", Value: strings.Repeat("R", 43)})
	actor, e := gateway.AuthorizeOperations(request, false, "audit.read")
	if e != nil {
		t.Fatal(e)
	}
	service := &Service{Domain: &businessadmin.Domain{Pool: pool, Endpoint: endpoint, Authority: gateway, Now: now}}
	defer service.Close()
	if _, e := service.Audit(ctx, actor, Object{"kind": "reads", "limit": 1}); e != nil {
		t.Fatal(e)
	}
	target := uuid.NewString()
	account := uuid.NewString()
	noticeID := uuid.NewString()
	if _, e = ownerPool.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,operation_id,http_request_id,selection,result,created_at,actor_kind) VALUES($1,$2,$3,'administrator','notice-create',$4,NULL,NULL,$5,$6,$7,'business-operator')`, noticeID, endpoint, rootID, account, Object{"planId": target, "kind": "create", "rawSecret": "synthetic hidden narrative"}, Object{"state": "draft", "version": 1, "rawBody": "synthetic hidden narrative"}, now()); e != nil {
		t.Fatal(e)
	}
	// DTO field/byte parity is covered by the fixed all-action projection
	// fixtures. This integration checks actual query selection and ordering,
	// cursor/page boundaries, safe search and read-audit writes against real rows.
	queries := []struct {
		input Object
		count int
	}{
		{Object{"kind": "business", "limit": 3}, 3},
		{Object{"kind": "business", "resourceId": target, "limit": 10}, 1},
		{Object{"kind": "business", "query": "synthetic hidden narrative", "limit": 10}, 0},
		{Object{"kind": "business", "page": 1, "pageSize": 20}, 4},
	}
	for index, query := range queries {
		got, e := service.Audit(ctx, actor, query.input)
		if e != nil {
			t.Fatal(e)
		}
		items, ok := got["items"].([]any)
		if !ok || len(items) != query.count {
			t.Fatalf("query%d selection differs: %s", index, mustJSON(got))
		}
		if query.count > 0 {
			first := obj(items[0])
			if first["id"] != noticeID || obj(first["selection"])["planId"] != target || obj(first["result"])["state"] != "draft" {
				t.Fatalf("query%d lost exact latest source: %s", index, mustJSON(got))
			}
		}
		if index == 3 {
			page := obj(got["pagination"])
			if page["total"] != 4 || str(page["snapshot"]) == "" {
				t.Fatalf("page selection differs %s", mustJSON(got))
			}
		} else if got["metadataOnly"] != true || got["checkedAt"] != clock || got["scanLimited"] != false || got["nextAfter"] != nil && query.count < 3 {
			t.Fatalf("query boundary differs %s", mustJSON(got))
		}
		if strings.Contains(mustJSON(got), "hidden narrative") {
			t.Fatal("raw audit prose escaped closed projection")
		}
	}
	if _, e = service.Audit(ctx, actor, Object{"accountId": account, "limit": 2}); e != nil {
		t.Fatal(e)
	}
	var recordedAccount string
	var selection Object
	if e = ownerPool.QueryRow(ctx, "SELECT account_id::text,selection FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='audit-read' ORDER BY sequence DESC LIMIT 1", endpoint).Scan(&recordedAccount, &selection); e != nil || recordedAccount != account {
		t.Fatalf("account-scoped read audit lost attribution %s %v", recordedAccount, e)
	}
	// Capture exact MVCC identities. A lower uncommitted sequence is absent even
	// after it commits; using only a high-water mark would incorrectly add it.
	isolated := uuid.NewString()
	pending, _ := ownerPool.Begin(ctx)
	insert := func(tx interface {
		Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	}, id string) {
		t.Helper()
		if _, e = tx.Exec(ctx, `INSERT INTO business_admin_audit_v1(id,endpoint,operator_id,operator_role,action,account_id,selection,result,created_at,actor_kind) VALUES($1,$2,$3,'administrator','notice-create',$4,'{}','{}',$5,'business-operator')`, id, endpoint, rootID, isolated, now()); e != nil {
			t.Fatal(e)
		}
	}
	low, high := uuid.NewString(), uuid.NewString()
	insert(pending, low)
	insert(ownerPool, high)
	q := Object{"accountId": isolated, "kind": "business", "page": 1, "pageSize": 20}
	page, e := service.Audit(ctx, actor, q)
	if e != nil {
		t.Fatal(e)
	}
	snapshotID := obj(page["pagination"])["snapshot"]
	if obj(page["pagination"])["total"] != 1 {
		t.Fatalf("snapshot saw uncommitted source %s", mustJSON(page))
	}
	if e = pending.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	q["snapshot"] = snapshotID
	page, e = service.Audit(ctx, actor, q)
	if e != nil || obj(page["pagination"])["total"] != 1 || obj(page["items"].([]any)[0])["id"] != high {
		t.Fatalf("snapshot changed after gap commit %s %v", mustJSON(page), e)
	}
	mismatch := Object{"accountId": isolated, "kind": "business", "page": 1, "snapshot": snapshotID, "query": "changed"}
	if _, e = service.Audit(ctx, actor, mismatch); fault.Code(e) != "audit_snapshot_mismatch" {
		t.Fatalf("snapshot scope was replaceable %v", e)
	}
	// The real HTTP boundary keeps the same current portal authority and binds
	// the final response request ID into the read audit, never a client header.
	handler := Handler{Service: service, Authority: gateway}
	for _, suffix := range []string{"/audit?kind=business&limit=2", "/users/" + account + "/audit?limit=2"} {
		req := request.Clone(ctx)
		req.URL.Path = "/v1/operations" + strings.Split(suffix, "?")[0]
		req.URL.RawQuery = strings.Split(suffix, "?")[1]
		response := httptest.NewRecorder()
		id := uuid.NewString()
		response.Header().Set("X-Request-ID", id)
		handler.ServeHTTP(response, req)
		if response.Code != 200 || response.Header().Get("X-Request-ID") != id || strings.Contains(response.Body.String(), "hidden narrative") {
			t.Fatalf("real audit HTTP boundary %d %s", response.Code, response.Body.String())
		}
		var recorded string
		if e = ownerPool.QueryRow(ctx, "SELECT http_request_id::text FROM business_admin_audit_v1 WHERE endpoint=$1 AND action='audit-read' ORDER BY sequence DESC LIMIT 1", endpoint).Scan(&recorded); e != nil || recorded != id {
			t.Fatalf("HTTP audit correlation lost %s %v", recorded, e)
		}
	}
	clock += 301
	if _, e = service.Audit(ctx, actor, q); fault.Code(e) != "audit_snapshot_expired" {
		t.Fatalf("fixed snapshot expiration missing %v", e)
	}
}
